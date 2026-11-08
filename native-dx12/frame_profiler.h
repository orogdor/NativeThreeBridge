#pragma once
// Asynchronous file logger. Render thread only enqueues a short CSV row;
// disk I/O happens on a separate thread and is never on the hot frame path.
#include <condition_variable>
#include <deque>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
namespace native_three {
class AsyncCsvLogger {
public:
    explicit AsyncCsvLogger(std::string filename):filename_(std::move(filename)){
        // All mutexes, condition variables and queue state are fully
        // constructed before the writer thread can access this object.
        thread_=std::thread([this]{run();});
    }
    AsyncCsvLogger(const AsyncCsvLogger&)=delete;
    AsyncCsvLogger& operator=(const AsyncCsvLogger&)=delete;
    ~AsyncCsvLogger(){
        {std::lock_guard<std::mutex> lock(mutex_);stopping_=true;}
        cv_.notify_one();
        thread_.join();
    }
    void enqueue(std::string row){
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if(queue_.size()>=4096){++discarded_;return;}
            queue_.push_back(std::move(row));
        }
        cv_.notify_one();
    }
    unsigned dropped() const {
        std::lock_guard<std::mutex> lock(mutex_);
        return discarded_;
    }
private:
    std::string filename_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<std::string> queue_;
    bool stopping_=false;
    unsigned discarded_=0;
    std::thread thread_;
    void run(){
        std::ofstream file(filename_,std::ios::app);
        if(file && file.tellp()==0)
            file<<"type,frame,frame_ms,js_ms,lighting_ms,draw_ms,present_ms,"
                   "fence_ms,gpu_shadow_ms,gpu_main_ms,trees_visible,"
                   "scene_changed,light_candidates,shadow_tree_candidates\n";
        while(true){
            std::deque<std::string> batch;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                cv_.wait(lock,[&]{return stopping_||!queue_.empty();});
                if(stopping_&&queue_.empty())return;
                batch.swap(queue_);
            }
            if(file){
                for(const auto& row:batch)file<<row<<'\n';
                file.flush();
            }
        }
    }
};
} // namespace native_three
