// src/data/resolution-manager.js - Multi-Resolution Data Manager
// Manages zoom-level dependent data loading with caching and prefetching

/**
 * LRU Cache for storing loaded detail chunks
 */
class LRUCache {
    constructor(maxSize = 30) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict oldest (first) entry
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }
}

/**
 * Resolution thresholds in microseconds
 * These determine which data resolution to use based on visible time range
 */
const RESOLUTION_THRESHOLDS = {
    // If visible range > 2 hours, use minute aggregates (1-min bins from minute_level.parquet)
    MINUTE_LEVEL: 120 * 60 * 1_000_000,  // 2 hours in microseconds

    // If visible range 1 min - 2 hours, use second-level aggregation (1-second bins from second_level.parquet)
    SECOND_LEVEL: 1 * 60 * 1_000_000,   // 1 minute in microseconds

    // If visible range < 1 minute, show full microsecond detail
    MICROSECOND_LEVEL: 0
};

/**
 * Soft transition configuration for smooth zoom
 * Uses hysteresis to prevent rapid toggling near boundaries
 */
const SOFT_TRANSITION_CONFIG = {
    // Transition zone as percentage of threshold (creates hysteresis)
    ZONE_PERCENT: 0.20,  // 20% zone around each threshold

    // Pre-fetch zone (start loading next resolution before needed)
    PREFETCH_PERCENT: 0.35,  // 35% before threshold

    // Hysteresis - require this much movement past threshold to switch
    HYSTERESIS_PERCENT: 0.10,  // 10% past threshold before switching back

    // Minimum time between resolution switches (prevents flicker)
    MIN_SWITCH_INTERVAL_MS: 200
};

/**
 * Resolution states
 */
const RESOLUTION = {
    MINUTE: 'minute',
    SECOND: 'second',
    DETAIL: 'detail'
};

/**
 * Multi-Resolution Data Manager
 * Orchestrates data loading at different zoom levels with intelligent caching
 * Now with soft resolution boundaries and smooth transitions
 */
export class ResolutionManager {
    constructor() {
        // Data caches
        this.minuteCache = null;        // Always in memory after init
        this.secondCache = null;        // Second-level pre-aggregated data
        this.detailCache = new LRUCache(50);  // Cache ~50 minute-chunks

        // Loading state
        this.loadingChunks = new Set();  // Prevent duplicate fetches
        this.prefetchQueue = [];          // Speculative loading queue
        this.isPrefetching = false;

        // Current state
        this.currentResolution = RESOLUTION.MINUTE;
        this.timeExtent = null;
        this.chunkIndex = null;  // Maps minute timestamps to chunk info

        // Data source reference (set during init)
        this.dataSource = null;

        // Callbacks
        this.onLoadingStart = null;
        this.onLoadingEnd = null;
        this.onResolutionChange = null;

        // Debouncing
        this.pendingRequest = null;
        this.abortController = null;

        // Smooth zoom state
        this.lastSwitchTime = 0;
        this.lastVisibleRange = Infinity;
        this.zoomDirection = 0;  // -1 = zooming in, 1 = zooming out, 0 = stable
        this.prefetchedData = new Map();  // Cache for pre-fetched resolution data
        this.isInTransitionZone = false;
        this.transitionProgress = 0;

        // Background loading state (no blocking overlay)
        this.backgroundLoadPromise = null;
        this.onBackgroundLoadStart = null;
        this.onBackgroundLoadProgress = null;
        this.onBackgroundLoadComplete = null;
    }

    /**
     * Initialize the resolution manager with a data source
     * @param {DataSource} dataSource - The data source instance
     * @returns {Promise<Array>} Initial minute-level data
     */
    async init(dataSource) {
        this.dataSource = dataSource;
        this.timeExtent = dataSource.timeExtent;
        
        console.log('[ResolutionManager] Initializing...');
        console.log(`[ResolutionManager] Time extent: [${this.timeExtent[0]}, ${this.timeExtent[1]}]`);
        
        // Load minute-level aggregates (small, fast)
        const startTime = performance.now();
        this.minuteCache = await this.dataSource.getMinuteAggregates();
        const loadTime = performance.now() - startTime;
        
        console.log(`[ResolutionManager] Loaded ${this.minuteCache.length} minute bins in ${loadTime.toFixed(0)}ms`);
        
        // Build chunk index for detail loading
        this._buildChunkIndex();
        
        return this.minuteCache;
    }

    /**
     * Get the required resolution for a given visible time range
     * Uses soft boundaries with hysteresis to prevent flickering
     * @param {number} visibleRange - Time range in microseconds
     * @returns {string} Resolution level ('minute', 'second', or 'detail')
     */
    getResolutionForRange(visibleRange) {
        const now = performance.now();
        const timeSinceLastSwitch = now - this.lastSwitchTime;

        // Determine zoom direction
        if (visibleRange < this.lastVisibleRange * 0.98) {
            this.zoomDirection = -1;  // Zooming in
        } else if (visibleRange > this.lastVisibleRange * 1.02) {
            this.zoomDirection = 1;  // Zooming out
        } else {
            this.zoomDirection = 0;  // Stable
        }
        this.lastVisibleRange = visibleRange;

        // Calculate thresholds - use simple thresholds with small hysteresis buffer
        const { ZONE_PERCENT, MIN_SWITCH_INTERVAL_MS } = SOFT_TRANSITION_CONFIG;

        // Use 5% hysteresis buffer to prevent flickering at boundaries
        const HYSTERESIS = 0.05;
        let minuteThreshold = RESOLUTION_THRESHOLDS.MINUTE_LEVEL;
        let secondThreshold = RESOLUTION_THRESHOLDS.SECOND_LEVEL;

        // Apply hysteresis based on current resolution to prevent bouncing
        if (this.currentResolution === RESOLUTION.MINUTE) {
            // To leave MINUTE, need to go 5% below the threshold
            minuteThreshold = RESOLUTION_THRESHOLDS.MINUTE_LEVEL * (1 - HYSTERESIS);
        } else if (this.currentResolution === RESOLUTION.SECOND) {
            // To go back to MINUTE, need to go 5% above the threshold
            minuteThreshold = RESOLUTION_THRESHOLDS.MINUTE_LEVEL * (1 + HYSTERESIS);
            // To go to DETAIL, need to go 5% below second threshold
            secondThreshold = RESOLUTION_THRESHOLDS.SECOND_LEVEL * (1 - HYSTERESIS);
        } else if (this.currentResolution === RESOLUTION.DETAIL) {
            // To go back to SECOND, need to go 5% above second threshold
            secondThreshold = RESOLUTION_THRESHOLDS.SECOND_LEVEL * (1 + HYSTERESIS);
        }

        // Calculate transition zone info
        const minuteZone = RESOLUTION_THRESHOLDS.MINUTE_LEVEL * ZONE_PERCENT;
        const secondZone = RESOLUTION_THRESHOLDS.SECOND_LEVEL * ZONE_PERCENT;

        this.isInTransitionZone =
            (Math.abs(visibleRange - RESOLUTION_THRESHOLDS.MINUTE_LEVEL) < minuteZone) ||
            (Math.abs(visibleRange - RESOLUTION_THRESHOLDS.SECOND_LEVEL) < secondZone);

        // Calculate transition progress for smooth visual blending
        if (Math.abs(visibleRange - RESOLUTION_THRESHOLDS.MINUTE_LEVEL) < minuteZone) {
            this.transitionProgress = 1 - (visibleRange - (RESOLUTION_THRESHOLDS.MINUTE_LEVEL - minuteZone)) / (2 * minuteZone);
            this.transitionProgress = Math.max(0, Math.min(1, this.transitionProgress));
        } else if (Math.abs(visibleRange - RESOLUTION_THRESHOLDS.SECOND_LEVEL) < secondZone) {
            this.transitionProgress = 1 - (visibleRange - (RESOLUTION_THRESHOLDS.SECOND_LEVEL - secondZone)) / (2 * secondZone);
            this.transitionProgress = Math.max(0, Math.min(1, this.transitionProgress));
        } else {
            this.transitionProgress = 0;
        }

        // Determine target resolution based on thresholds
        let targetResolution;
        if (visibleRange > minuteThreshold) {
            targetResolution = RESOLUTION.MINUTE;
        } else if (visibleRange > secondThreshold) {
            targetResolution = RESOLUTION.SECOND;
        } else {
            targetResolution = RESOLUTION.DETAIL;
        }

        // Log resolution decisions for debugging
        console.log(`[ResolutionManager] visibleRange=${(visibleRange/1_000_000).toFixed(1)}s, current=${this.currentResolution}, target=${targetResolution}, minuteThresh=${(minuteThreshold/1_000_000/60).toFixed(1)}min, secondThresh=${(secondThreshold/1_000_000).toFixed(1)}s`);

        // Enforce minimum switch interval to prevent rapid toggling (50ms)
        const effectiveMinInterval = Math.min(MIN_SWITCH_INTERVAL_MS, 50);
        if (targetResolution !== this.currentResolution) {
            if (timeSinceLastSwitch < effectiveMinInterval) {
                // Too soon to switch, stay at current resolution
                return this.currentResolution;
            }
            this.lastSwitchTime = now;
            // Update internal state immediately
            console.log(`[ResolutionManager] Switching resolution: ${this.currentResolution} → ${targetResolution}`);
            this.currentResolution = targetResolution;
        }

        return targetResolution;
    }

    /**
     * Get extended resolution info including transition state
     * @param {number} visibleRange - Time range in microseconds
     * @returns {Object} Resolution info with transition details
     */
    getResolutionInfo(visibleRange) {
        const previousResolution = this.currentResolution;
        const resolution = this.getResolutionForRange(visibleRange);
        const { PREFETCH_PERCENT } = SOFT_TRANSITION_CONFIG;

        // Calculate what resolution to pre-fetch
        let prefetchResolution = null;
        if (resolution === RESOLUTION.MINUTE && this.zoomDirection === -1) {
            const prefetchThreshold = RESOLUTION_THRESHOLDS.MINUTE_LEVEL * (1 + PREFETCH_PERCENT);
            if (visibleRange < prefetchThreshold) {
                prefetchResolution = RESOLUTION.SECOND;
            }
        }
        if (resolution === RESOLUTION.SECOND && this.zoomDirection === -1) {
            const prefetchThreshold = RESOLUTION_THRESHOLDS.SECOND_LEVEL * (1 + PREFETCH_PERCENT);
            if (visibleRange < prefetchThreshold) {
                prefetchResolution = RESOLUTION.DETAIL;
            }
        }

        // switchedResolution is true if resolution changed during this call
        const switchedResolution = resolution !== previousResolution;

        return {
            resolution,
            isInTransitionZone: this.isInTransitionZone,
            transitionProgress: this.transitionProgress,
            zoomDirection: this.zoomDirection,
            shouldPrefetch: prefetchResolution !== null,
            prefetchResolution,
            switchedResolution
        };
    }

    /**
     * Get data appropriate for the current domain/zoom level
     * @param {[number, number]} domain - [startTime, endTime] in microseconds
     * @returns {Promise<{data: Array, resolution: string, fromCache: boolean}>}
     */
    async getDataForDomain(domain) {
        const [start, end] = domain;
        const visibleRange = end - start;
        const requiredResolution = this.getResolutionForRange(visibleRange);
        
        console.log(`[ResolutionManager] Getting data for domain [${start}, ${end}], range=${(visibleRange/1_000_000).toFixed(1)}s, resolution=${requiredResolution}`);
        
        // Cancel any pending request
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();
        
        let data;
        let fromCache = true;
        
        switch (requiredResolution) {
            case RESOLUTION.MINUTE:
                // Filter minute cache to domain
                data = this._filterMinuteData(domain);
                break;
                
            case RESOLUTION.SECOND:
                // Re-aggregate minute data into second-level bins for visible range
                data = await this._getSecondLevelData(domain);
                fromCache = false;
                break;
                
            case RESOLUTION.DETAIL:
                // Load full detail for visible range
                data = await this._getDetailData(domain);
                fromCache = this._allChunksInCache(domain);
                break;
        }
        
        // Update current resolution
        const changed = this.currentResolution !== requiredResolution;
        this.currentResolution = requiredResolution;
        
        if (changed && this.onResolutionChange) {
            this.onResolutionChange(requiredResolution, this.currentResolution);
        }
        
        return { data, resolution: requiredResolution, fromCache };
    }

    /**
     * Get data for domain with non-blocking background loading
     * Returns current data immediately while loading better data in background
     * @param {[number, number]} domain - [startTime, endTime] in microseconds
     * @returns {Object} { data, resolution, isLoading, loadingPromise }
     */
    async getDataForDomainNonBlocking(domain) {
        const [start, end] = domain;
        const visibleRange = end - start;
        console.log(`[ResManager-NonBlocking] domain=[${start}, ${end}], visibleRange=${(visibleRange/1_000_000).toFixed(2)}s`);

        const resInfo = this.getResolutionInfo(visibleRange);
        const requiredResolution = resInfo.resolution;
        console.log(`[ResManager-NonBlocking] requiredResolution=${requiredResolution}, switchedResolution=${resInfo.switchedResolution}`);

        // Always return current cached data immediately
        let immediateData = this._getImmediateData(domain, requiredResolution);
        console.log(`[ResManager-NonBlocking] immediateData.length=${immediateData.length}`);
        let isLoading = false;
        let loadingPromise = null;

        // Check if we need to load better data in background
        const needsSecondLoad = requiredResolution === RESOLUTION.SECOND && (!this.secondCache || this.secondCache.length === 0);
        const needsDetailLoad = requiredResolution === RESOLUTION.DETAIL && !this._allChunksInCache(domain);
        const needsBackgroundLoad = resInfo.switchedResolution || needsSecondLoad || needsDetailLoad;
        console.log(`[ResManager-NonBlocking] needsBackgroundLoad=${needsBackgroundLoad}, needsSecondLoad=${needsSecondLoad}, needsDetailLoad=${needsDetailLoad}`);

        if (needsBackgroundLoad) {
            isLoading = true;

            // Notify background load starting (for subtle UI indicator)
            if (this.onBackgroundLoadStart) {
                this.onBackgroundLoadStart(requiredResolution);
            }

            // Start background load
            loadingPromise = this._loadDataInBackground(domain, requiredResolution)
                .then(data => {
                    if (this.onBackgroundLoadComplete) {
                        this.onBackgroundLoadComplete(data, requiredResolution);
                    }
                    return data;
                })
                .catch(err => {
                    console.error('[ResolutionManager] Background load failed:', err);
                    return null;
                });
        }

        // Update current resolution
        const changed = this.currentResolution !== requiredResolution;
        this.currentResolution = requiredResolution;

        if (changed && this.onResolutionChange) {
            this.onResolutionChange(requiredResolution, resInfo);
        }

        return {
            data: immediateData,
            resolution: requiredResolution,
            isLoading,
            loadingPromise,
            transitionInfo: resInfo
        };
    }

    /**
     * Get best available data immediately without blocking
     * @private
     */
    _getImmediateData(domain, targetResolution) {
        // Try to get data from the target resolution's cache first
        if (targetResolution === RESOLUTION.MINUTE && this.minuteCache) {
            return this._filterMinuteData(domain);
        }

        // For SECOND, check second cache first
        if (targetResolution === RESOLUTION.SECOND && this.secondCache && this.secondCache.length > 0) {
            return this._filterSecondData(domain);
        }

        // For DETAIL, check if we have cached data
        if (targetResolution === RESOLUTION.DETAIL) {
            const cachedData = this._assembleFromCache(this._getChunksInRange(domain), domain);
            if (cachedData.length > 0) {
                return cachedData;
            }
        }

        // Fall back to minute cache if nothing better available
        if (this.minuteCache) {
            return this._filterMinuteData(domain);
        }

        return [];
    }

    /**
     * Filter second-level cache to domain
     * @private
     */
    _filterSecondData(domain) {
        if (!this.secondCache) return [];
        const [start, end] = domain;
        return this.secondCache.filter(d => {
            const t = d.binStart || d.timestamp;
            return t >= start && t <= end;
        });
    }

    /**
     * Load data in background without blocking UI
     * @private
     */
    async _loadDataInBackground(domain, resolution) {
        console.log(`[ResManager-BgLoad] Starting background load for resolution=${resolution}`);
        // Cancel any existing background load
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        try {
            let result;
            switch (resolution) {
                case RESOLUTION.MINUTE:
                    result = this._filterMinuteData(domain);
                    console.log(`[ResManager-BgLoad] MINUTE: ${result.length} items`);
                    return result;

                case RESOLUTION.SECOND:
                    result = await this._getSecondLevelData(domain);
                    // Cache the loaded second-level data
                    this.secondCache = result;
                    console.log(`[ResManager-BgLoad] SECOND: ${result.length} items (cached)`);
                    return result;

                case RESOLUTION.DETAIL:
                    result = await this._getDetailData(domain);
                    console.log(`[ResManager-BgLoad] DETAIL: ${result.length} items`);
                    return result;

                default:
                    result = this._filterMinuteData(domain);
                    console.log(`[ResManager-BgLoad] DEFAULT: ${result.length} items`);
                    return result;
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('[ResolutionManager] Background load aborted (superseded)');
                return null;
            }
            console.error('[ResManager-BgLoad] Error:', err);
            throw err;
        }
    }

    /**
     * Speculative prefetch for adjacent time chunks
     * Called during zoom to preload nearby data
     * @param {[number, number]} domain - Current visible domain
     * @param {number} numChunks - Number of adjacent chunks to prefetch (default 2)
     */
    prefetchAdjacent(domain, numChunks = 2) {
        if (this.currentResolution !== RESOLUTION.DETAIL) {
            return; // Only prefetch when at detail level
        }

        const chunkIds = this._getChunksInRange(domain);
        const adjacent = this._getAdjacentChunks(chunkIds, numChunks);

        // Add to prefetch queue
        for (const chunkId of adjacent) {
            if (!this.detailCache.has(chunkId) &&
                !this.loadingChunks.has(chunkId) &&
                !this.prefetchQueue.includes(chunkId)) {
                this.prefetchQueue.push(chunkId);
            }
        }

        // Process queue
        this._processPrefetchQueue();
    }

    /**
     * Aggressively prefetch next resolution data based on zoom direction
     * Call this when user is zooming toward a threshold
     * @param {[number, number]} domain - Current domain
     * @param {string} targetResolution - Resolution to prefetch
     */
    prefetchResolution(domain, targetResolution) {
        if (!targetResolution || targetResolution === this.currentResolution) return;

        const cacheKey = `${domain[0]}_${domain[1]}_${targetResolution}`;
        if (this.prefetchedData.has(cacheKey)) return;

        console.log(`[ResolutionManager] Pre-fetching ${targetResolution} data for upcoming transition`);

        this._loadDataInBackground(domain, targetResolution)
            .then(data => {
                if (data) {
                    this.prefetchedData.set(cacheKey, data);
                    console.log(`[ResolutionManager] Pre-fetched ${data.length} items for ${targetResolution}`);
                }
            })
            .catch(err => {
                console.warn(`[ResolutionManager] Prefetch failed for ${targetResolution}:`, err);
            });
    }

    /**
     * Clear all cached data
     */
    clear() {
        this.minuteCache = null;
        this.secondCache = null;
        this.detailCache.clear();
        this.loadingChunks.clear();
        this.prefetchQueue = [];
        this.chunkIndex = null;
        this.currentResolution = RESOLUTION.MINUTE;
    }

    /**
     * Get current memory usage estimate
     * @returns {Object} Memory usage stats
     */
    getMemoryStats() {
        const minuteSize = this.minuteCache ? this.minuteCache.length * 100 : 0; // ~100 bytes per bin
        const detailSize = this.detailCache.size * 30000 * 100; // ~30K packets per chunk, 100 bytes each
        
        return {
            minuteCacheEntries: this.minuteCache ? this.minuteCache.length : 0,
            minuteCacheSizeKB: Math.round(minuteSize / 1024),
            detailCacheChunks: this.detailCache.size,
            detailCacheSizeKB: Math.round(detailSize / 1024),
            totalSizeKB: Math.round((minuteSize + detailSize) / 1024),
            loadingChunks: this.loadingChunks.size,
            prefetchQueueLength: this.prefetchQueue.length
        };
    }

    // ========== PRIVATE METHODS ==========

    /**
     * Build chunk index from time extent
     * @private
     */
    _buildChunkIndex() {
        if (!this.timeExtent) return;
        
        const [minTime, maxTime] = this.timeExtent;
        const chunkSize = 60_000_000; // 1 minute in microseconds
        
        this.chunkIndex = new Map();
        
        // Create chunk entries for each minute in the time extent
        let chunkStart = Math.floor(minTime / chunkSize) * chunkSize;
        while (chunkStart <= maxTime) {
            this.chunkIndex.set(chunkStart, {
                id: chunkStart,
                start: chunkStart,
                end: chunkStart + chunkSize,
                loaded: false
            });
            chunkStart += chunkSize;
        }
        
        console.log(`[ResolutionManager] Built chunk index with ${this.chunkIndex.size} chunks`);
    }

    /**
     * Filter minute-level cache to visible domain
     * @private
     */
    _filterMinuteData(domain) {
        const [start, end] = domain;
        if (!this.minuteCache) return [];
        
        return this.minuteCache.filter(bin => {
            const binTime = bin.timestamp || bin.binStart;
            return binTime >= start && binTime <= end;
        });
    }

    /**
     * Get second-level aggregation for a domain
     * Uses pre-aggregated second-level parquet file if available
     * @private
     */
    async _getSecondLevelData(domain) {
        if (this.onLoadingStart) this.onLoadingStart();
        
        try {
            // Use pre-aggregated second-level data (already binned at 1-minute intervals)
            // This avoids re-binning and uses the pre-computed aggregates
            const data = await this.dataSource.getSecondAggregates(domain);
            return data;
        } finally {
            if (this.onLoadingEnd) this.onLoadingEnd();
        }
    }

    /**
     * Get detail-level data for a domain
     * Loads from cache or fetches missing chunks
     * @private
     */
    async _getDetailData(domain) {
        console.log(`[ResManager-Detail] Getting detail data for domain [${domain[0]}, ${domain[1]}]`);
        const chunkIds = this._getChunksInRange(domain);
        console.log(`[ResManager-Detail] chunkIds=${JSON.stringify(chunkIds)}, chunkIndex.size=${this.chunkIndex?.size || 'null'}`);
        const missingChunks = chunkIds.filter(id => !this.detailCache.has(id));

        console.log(`[ResolutionManager] Detail request: ${chunkIds.length} chunks needed, ${missingChunks.length} missing`);

        if (missingChunks.length > 0) {
            console.log(`[ResManager-Detail] Loading ${missingChunks.length} missing chunks...`);
            if (this.onLoadingStart) this.onLoadingStart();

            try {
                // Load missing chunks in parallel
                await Promise.all(missingChunks.map(id => this._loadChunk(id)));
                console.log(`[ResManager-Detail] All chunks loaded successfully`);
            } catch (err) {
                console.error('[ResManager-Detail] Error loading chunks:', err);
                throw err;
            } finally {
                if (this.onLoadingEnd) this.onLoadingEnd();
            }
        } else {
            console.log(`[ResManager-Detail] All chunks already in cache`);
        }
        
        // Assemble data from cache
        return this._assembleFromCache(chunkIds, domain);
    }

    /**
     * Check if all chunks for a domain are in cache
     * @private
     */
    _allChunksInCache(domain) {
        const chunkIds = this._getChunksInRange(domain);
        return chunkIds.every(id => this.detailCache.has(id));
    }

    /**
     * Get chunk IDs that overlap with a domain
     * @private
     */
    _getChunksInRange(domain) {
        const [start, end] = domain;
        const chunkSize = 60_000_000; // 1 minute

        const startChunk = Math.floor(start / chunkSize) * chunkSize;
        const endChunk = Math.floor(end / chunkSize) * chunkSize;

        console.log(`[ResManager-Chunks] domain=[${start}, ${end}], startChunk=${startChunk}, endChunk=${endChunk}`);
        console.log(`[ResManager-Chunks] chunkIndex has ${this.chunkIndex?.size || 0} entries`);

        const chunks = [];
        for (let chunk = startChunk; chunk <= endChunk; chunk += chunkSize) {
            const exists = this.chunkIndex && this.chunkIndex.has(chunk);
            if (exists) {
                chunks.push(chunk);
            } else {
                console.log(`[ResManager-Chunks] Chunk ${chunk} not in index`);
            }
        }

        console.log(`[ResManager-Chunks] Found ${chunks.length} chunks in range`);
        return chunks;
    }

    /**
     * Get adjacent chunks for prefetching
     * @private
     */
    _getAdjacentChunks(currentChunks, numAdjacent = 2) {
        if (currentChunks.length === 0) return [];
        
        const chunkSize = 60_000_000;
        const minChunk = Math.min(...currentChunks);
        const maxChunk = Math.max(...currentChunks);
        
        const adjacent = [];
        
        // Get chunks before
        for (let i = 1; i <= numAdjacent; i++) {
            const prevChunk = minChunk - (i * chunkSize);
            if (this.chunkIndex && this.chunkIndex.has(prevChunk)) {
                adjacent.push(prevChunk);
            }
        }
        
        // Get chunks after
        for (let i = 1; i <= numAdjacent; i++) {
            const nextChunk = maxChunk + (i * chunkSize);
            if (this.chunkIndex && this.chunkIndex.has(nextChunk)) {
                adjacent.push(nextChunk);
            }
        }
        
        return adjacent;
    }

    /**
     * Load a single chunk from data source
     * @private
     */
    async _loadChunk(chunkId) {
        if (this.detailCache.has(chunkId) || this.loadingChunks.has(chunkId)) {
            return;
        }
        
        this.loadingChunks.add(chunkId);
        
        try {
            const startTime = performance.now();
            const chunkEnd = chunkId + 60_000_000;
            
            // Query detail for this minute
            const packets = await this.dataSource.getDetailData([chunkId, chunkEnd], 100000);
            
            this.detailCache.set(chunkId, packets);
            
            const loadTime = performance.now() - startTime;
            console.log(`[ResolutionManager] Loaded chunk ${chunkId}: ${packets.length} packets in ${loadTime.toFixed(0)}ms`);
        } catch (err) {
            console.error(`[ResolutionManager] Error loading chunk ${chunkId}:`, err);
        } finally {
            this.loadingChunks.delete(chunkId);
        }
    }

    /**
     * Assemble packets from cached chunks
     * @private
     */
    _assembleFromCache(chunkIds, domain) {
        const [start, end] = domain;
        const allPackets = [];
        
        for (const chunkId of chunkIds) {
            const chunkPackets = this.detailCache.get(chunkId);
            if (chunkPackets) {
                // Filter to exact domain
                const filtered = chunkPackets.filter(p => 
                    p.timestamp >= start && p.timestamp <= end
                );
                allPackets.push(...filtered);
            }
        }
        
        // Sort by timestamp
        allPackets.sort((a, b) => a.timestamp - b.timestamp);
        
        return allPackets;
    }

    /**
     * Process prefetch queue in background
     * @private
     */
    async _processPrefetchQueue() {
        if (this.isPrefetching || this.prefetchQueue.length === 0) {
            return;
        }
        
        this.isPrefetching = true;
        
        while (this.prefetchQueue.length > 0) {
            const chunkId = this.prefetchQueue.shift();
            
            if (!this.detailCache.has(chunkId) && !this.loadingChunks.has(chunkId)) {
                try {
                    await this._loadChunk(chunkId);
                } catch (err) {
                    console.warn(`[ResolutionManager] Prefetch failed for chunk ${chunkId}:`, err);
                }
            }
            
            // Small delay to not block main thread
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        this.isPrefetching = false;
    }
}

// Export constants for external use
export { RESOLUTION, RESOLUTION_THRESHOLDS, SOFT_TRANSITION_CONFIG, LRUCache };

// Export singleton instance
export const resolutionManager = new ResolutionManager();

