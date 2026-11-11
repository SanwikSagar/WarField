export class AssetStream {
    constructor(limit = 3) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.completed = 0;
        this.pending = [];
        this.jobs = new Map();
        this.scheduled = false;
        this.sequence = 0;
    }

    request(key, load, priority = 0) {
        const existing = this.jobs.get(key);
        if (existing) {
            existing.priority = Math.min(existing.priority, priority);
            return existing.promise;
        }
        const job = { key, load, priority, sequence: this.sequence++ };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        this.jobs.set(key, job);
        this.pending.push(job);
        if (!this.scheduled) {
            this.scheduled = true;
            queueMicrotask(() => { this.scheduled = false; this._drain(); });
        }
        return job.promise;
    }

    _drain() {
        this.pending.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
        while (this.active < this.limit && this.pending.length) {
            const job = this.pending.shift();
            this.active++;
            Promise.resolve().then(job.load).then(job.resolve, job.reject).finally(() => {
                this.active--;
                this.completed++;
                this.jobs.delete(job.key);
                job.load = job.resolve = job.reject = null;
                this._drain();
            });
        }
    }

    getStats() {
        return { active: this.active, pending: this.pending.length, completed: this.completed, limit: this.limit };
    }
}

export const assetStream = new AssetStream(3);