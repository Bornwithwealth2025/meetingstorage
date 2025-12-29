// ProcessingQueue.js
class ProcessingQueue {
  constructor(options = {}) {
    this.queue = [];
    this.isProcessing = false;
    this.processingDelay = options.processingDelay || 100;
    this.maxConcurrent = options.maxConcurrent || 1;
    this.activeJobs = 0;
    this.onJobComplete = options.onJobComplete || null;
    this.onError = options.onError || null;
  }

  add(job, priority = 0) {
    const jobEntry = { job, priority, addedAt: Date.now() };
    this.queue.push(jobEntry);
    this.queue.sort((a, b) => b.priority - a.priority); // Higher priority first
    this.process();
  }

  async process() {
    
    if (this.isProcessing || 
        this.queue.length === 0 || 
        this.activeJobs >= this.maxConcurrent) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.queue.length > 0 && this.activeJobs < this.maxConcurrent) {
      const jobEntry = this.queue.shift();
      this.activeJobs++;
      
      this.executeJob(jobEntry.job).finally(() => {
        this.activeJobs--;
        this.process();
      });
      
      // Add delay to prevent CPU overload if needed
      if (this.processingDelay > 0 && this.queue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.processingDelay));
      }
    }
    
    this.isProcessing = false;
  }

  async executeJob(job) {
    try {
      await job();
      if (this.onJobComplete) {
        this.onJobComplete();
      }
    } catch (error) {
      console.error('Queue job error:', error);
      if (this.onError) {
        this.onError(error);
      }
    }
  }

  clear() {
    this.queue = [];
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      activeJobs: this.activeJobs,
      maxConcurrent: this.maxConcurrent
    };
  }
}

module.exports = ProcessingQueue;