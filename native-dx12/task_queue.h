#pragma once
// Background threads that run queued jobs (file reads, image decoding).
// Portable: no Windows, V8 or DX12 dependency.
//
// Threads start lazily on the first post(). stop() drops jobs that have not
// started yet, waits for running ones and joins every thread; the queue can
// be used again afterwards (a page reload reuses it).
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

namespace native_three {

class TaskQueue {
public:
    explicit TaskQueue(unsigned threads = 1) : threadCount_(std::max(1u, threads)) {}
    ~TaskQueue() { stop(); }
    TaskQueue(const TaskQueue&) = delete;
    TaskQueue& operator=(const TaskQueue&) = delete;

    // Worker count for CPU-bound jobs: leave one core for JavaScript and one
    // for the renderer, at least 1, at most `cap`.
    static unsigned cpuThreads(unsigned cap) {
        const unsigned hw = std::thread::hardware_concurrency();
        return std::max(1u, std::min(cap, hw > 2 ? hw - 2 : 1u));
    }

    void post(std::function<void()> job) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stopping_) return;
            jobs_.push_back(std::move(job));
            if (threads_.size() < threadCount_ && idle_ == 0)
                threads_.emplace_back([this] { run(); });
        }
        cv_.notify_one();
    }

    void stop() {
        std::vector<std::thread> threads;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stopping_ = true;
            jobs_.clear();
            threads.swap(threads_);
        }
        cv_.notify_all();
        for (auto& t : threads)
            if (t.joinable()) t.join();
        std::lock_guard<std::mutex> lock(mutex_);
        stopping_ = false;
        idle_ = 0;
    }

private:
    void run() {
        std::unique_lock<std::mutex> lock(mutex_);
        for (;;) {
            idle_++;
            cv_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
            idle_--;
            if (stopping_) return;
            std::function<void()> job = std::move(jobs_.front());
            jobs_.pop_front();
            lock.unlock();
            job();
            lock.lock();
        }
    }

    const unsigned threadCount_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::deque<std::function<void()>> jobs_;
    std::vector<std::thread> threads_;
    unsigned idle_ = 0;
    bool stopping_ = false;
};

} // namespace native_three
