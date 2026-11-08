#pragma once
// Optional asynchronous, grid-based navigation provider for the native engine.
// Grid policy is independent of rendering or any particular game's agents.
// Moving-agent collision/reservations remain a separate local steering concern.
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>
#include <cmath>

namespace native_three {
enum class RouteStatus { Found, NoPath, Canceled, Invalid, BudgetExceeded };
struct RouteResult {
    std::uint64_t token=0;
    RouteStatus status=RouteStatus::Invalid;
    std::vector<std::uint32_t> cells;
};
class NavigationService {
public:
    explicit NavigationService(unsigned workers=2) {
        workers=std::max(1u,std::min(workers,8u));
        for(unsigned i=0;i<workers;i++)workers_.emplace_back([this]{worker();});
    }
    NavigationService(const NavigationService&)=delete;
    NavigationService& operator=(const NavigationService&)=delete;
    ~NavigationService(){
        {std::lock_guard<std::mutex> lock(mutex_);stop_=true;}
        cv_.notify_all();
        for(auto& thread:workers_)thread.join();
    }
    void setMap(std::uint32_t width,std::uint32_t height,
                std::vector<std::uint8_t> blocked) {
        if(!width||!height||std::uint64_t(width)*height!=blocked.size())return;
        auto map=std::make_shared<Grid>();
        map->width=width;map->height=height;map->blocked=std::move(blocked);
        std::lock_guard<std::mutex> lock(mutex_);
        grid_=std::move(map);
    }
    std::uint64_t request(std::uint32_t start,std::uint32_t goal,bool urgent=false) {
        const auto token=nextToken_++;
        auto cancel=std::make_shared<std::atomic<bool>>(false);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            pendingFlags_[token]=cancel;
            Request r{token,start,goal,grid_,cancel};
            if(urgent)pending_.push_front(std::move(r));
            else pending_.push_back(std::move(r));
        }
        cv_.notify_one();
        return token;
    }
    bool cancel(std::uint64_t token) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it=pendingFlags_.find(token);
        if(it==pendingFlags_.end())return false;
        it->second->store(true,std::memory_order_relaxed);
        return true;
    }
    // Non-blocking; a game can call this each simulation tick. No render-thread wait.
    bool poll(RouteResult& out) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(finished_.empty())return false;
        out=std::move(finished_.front());
        finished_.pop_front();
        pendingFlags_.erase(out.token);
        return true;
    }
    std::size_t pending() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return pendingFlags_.size();
    }
private:
    struct Grid {
        std::uint32_t width=0,height=0;
        std::vector<std::uint8_t> blocked;
    };
    struct Request {
        std::uint64_t token;
        std::uint32_t start,goal;
        std::shared_ptr<const Grid> map;
        std::shared_ptr<std::atomic<bool>> canceled;
    };
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<Request> pending_;
    std::deque<RouteResult> finished_;
    std::vector<std::thread> workers_;
    std::unordered_map<std::uint64_t,std::shared_ptr<std::atomic<bool>>> pendingFlags_;
    std::shared_ptr<const Grid> grid_;
    std::atomic<std::uint64_t> nextToken_{1};
    bool stop_=false;
    struct HeapNode {std::uint32_t node;float cost;};
    static RouteResult route(const Request& request) {
        RouteResult result;result.token=request.token;
        const Grid* grid=request.map.get();
        if(!grid||request.start>=grid->blocked.size()||
           request.goal>=grid->blocked.size()||
           grid->blocked[request.start]||grid->blocked[request.goal])
            return result;
        const std::uint32_t w=grid->width,goal=request.goal;
        const auto h=[&](std::uint32_t n) {
            return float(std::abs(int(n%w)-int(goal%w))+
                         std::abs(int(n/w)-int(goal/w)));
        };
        const std::size_t size=grid->blocked.size();
        std::vector<float> cost(size,1.e30f);
        std::vector<std::int32_t> parent(size,-1);
        std::vector<std::uint8_t> closed(size,0);
        std::vector<HeapNode> heap;
        heap.reserve(std::min(std::size_t(4096),size));
        const auto cmp=[](const HeapNode& a,const HeapNode& b){return a.cost>b.cost;};
        cost[request.start]=0;
        heap.push_back({request.start,h(request.start)});
        const std::size_t maxExpansions=std::max(std::size_t(1000),size*4);
        std::size_t expanded=0;
        while(!heap.empty()) {
            if((expanded&511u)==0 && request.canceled->load(std::memory_order_relaxed)){
                result.status=RouteStatus::Canceled;return result;
            }
            std::pop_heap(heap.begin(),heap.end(),cmp);
            const auto n=heap.back().node;heap.pop_back();
            if(closed[n])continue;
            if(n==goal) {
                for(std::int32_t p=(std::int32_t)n;p>=0;p=parent[p])
                    result.cells.push_back((std::uint32_t)p);
                std::reverse(result.cells.begin(),result.cells.end());
                result.status=RouteStatus::Found;
                return result;
            }
            if(++expanded>maxExpansions){
                result.status=RouteStatus::BudgetExceeded;return result;
            }
            closed[n]=1;
            const auto tryNext=[&](std::uint32_t next) {
                if(grid->blocked[next]||closed[next])return;
                const float candidate=cost[n]+1.f;
                if(candidate>=cost[next])return;
                cost[next]=candidate;parent[next]=(std::int32_t)n;
                heap.push_back({next,candidate+h(next)});
                std::push_heap(heap.begin(),heap.end(),cmp);
            };
            if(n%w>0)tryNext(n-1);
            if(n%w+1<w)tryNext(n+1);
            if(n>=w)tryNext(n-w);
            if(n+w<size)tryNext(n+w);
        }
        result.status=request.canceled->load()?RouteStatus::Canceled:RouteStatus::NoPath;
        return result;
    }
    void worker() {
        while(true) {
            Request request{};
            {
                std::unique_lock<std::mutex> lock(mutex_);
                cv_.wait(lock,[&]{return stop_||!pending_.empty();});
                if(stop_)return; // shutdown does not drain an unbounded game queue
                request=std::move(pending_.front());pending_.pop_front();
            }
            RouteResult result=request.canceled->load()?RouteResult{request.token,RouteStatus::Canceled,{}}:route(request);
            {
                std::lock_guard<std::mutex> lock(mutex_);
                finished_.push_back(std::move(result));
            }
        }
    }
};
} // namespace native_three
