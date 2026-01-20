// src/data/data-source.js - Unified Data Source Interface
// Part of Phase 2: DuckDB Query Engine (Behind Feature Flag)
// Part of Phase 3: Multi-Resolution Loading Support
// Provides a common interface for both legacy (CSV) and DuckDB (Parquet) data sources

import { FolderLoader } from '../../folder_loader.js';
import * as DuckDBLoader from './duckdb-loader.js';
import { resolutionManager } from './resolution-manager.js';
import { componentLoader } from './component-loader.js';

// Track pre-aggregate availability
let preAggregatesAvailable = { minute: false, second: false, metadata: null };

/**
 * Unified data source that supports both legacy and DuckDB modes
 * Automatically detects best mode or follows URL parameters
 */
export class DataSource {
    constructor() {
        this.mode = 'legacy';  // 'legacy' or 'duckdb'
        this.folderLoader = new FolderLoader();
        this.duckdbConn = null;
        this.timeExtent = null;
        this.folderHandle = null;
        this.manifest = null;
        this.packets = null;
        this.flowsIndex = null;
        this.ipStats = null;
        this.flagStats = null;
    }

    /**
     * Initialize data source with folder handle
     * @param {FileSystemDirectoryHandle} folderHandle - Folder containing data
     * @param {Object} options - Configuration options
     * @param {boolean} options.useDuckDB - Force DuckDB mode (overrides auto-detection)
     * @returns {Promise<{mode: string, timeExtent: [number, number], packetCount: number}>}
     */
    async init(folderHandle, options = {}) {
        this.folderHandle = folderHandle;

        // Check manifest first to detect format
        const manifestFormat = await this._checkManifestFormat(folderHandle);

        // Check if CSV multi-resolution format (v3.0)
        if (manifestFormat === 'multires_packets') {
            return await this._initMultiResCSV(folderHandle);
        }

        // Check if Parquet file is available
        const hasParquet = await this._checkParquetAvailable(folderHandle);

        // Check URL parameter or option for mode
        const urlParams = new URLSearchParams(location.search);
        const forceDuckDB = options.useDuckDB ?? urlParams.has('duckdb');
        const forceLegacy = urlParams.has('legacy');

        // Determine mode
        let useDuckDB = false;
        if (forceLegacy) {
            useDuckDB = false;
            console.log('[DataSource] Legacy mode forced via URL parameter');
        } else if (forceDuckDB) {
            useDuckDB = hasParquet;
            if (!hasParquet) {
                console.warn('[DataSource] DuckDB requested but no Parquet file found, falling back to legacy');
            }
        } else {
            // Auto-detect: use DuckDB if Parquet is available
            useDuckDB = hasParquet;
        }

        // Initialize based on mode
        if (useDuckDB) {
            try {
                console.log('[DataSource] Initializing DuckDB mode...');
                const result = await DuckDBLoader.loadParquetFile(folderHandle);
                this.duckdbConn = result.conn;
                this.timeExtent = result.timeExtent;
                this.mode = 'duckdb';

                // Also load manifest for metadata
                this.folderLoader.folderHandle = folderHandle;
                await this.folderLoader.loadManifest();
                this.manifest = this.folderLoader.manifest;

                console.log(`[DataSource] DuckDB mode active: ${result.packetCount.toLocaleString()} packets`);

                // Pre-aggregates already checked during loadParquetFile
                preAggregatesAvailable = await DuckDBLoader.checkPreAggregatesAvailable(folderHandle);

                if (result.hasPreAggregates || preAggregatesAvailable.minute) {
                    console.log('[DataSource] ⚡ Pre-aggregated resolution pyramid available!');
                    console.log('[DataSource] 💾 Memory-efficient lazy loading enabled');
                }

                return {
                    mode: this.mode,
                    timeExtent: this.timeExtent,
                    packetCount: result.packetCount,
                    hasPreAggregates: result.hasPreAggregates || preAggregatesAvailable.minute,
                    lazyLoaded: result.lazyLoaded
                };
            } catch (err) {
                console.warn('[DataSource] DuckDB initialization failed, falling back to legacy:', err);
                useDuckDB = false;
                this.mode = 'legacy';
            }
        }

        // Legacy mode
        if (!useDuckDB) {
            console.log('[DataSource] Initializing legacy mode...');
            this.mode = 'legacy';
            this.folderLoader.folderHandle = folderHandle;

            await this.folderLoader.loadManifest();
            this.manifest = this.folderLoader.manifest;

            // Load packets
            const packets = await this.folderLoader.loadPackets((progress, current, total) => {
                console.log(`[DataSource] Loading packets: ${current}/${total} (${progress.toFixed(1)}%)`);
            });

            this.packets = packets;
            this.timeExtent = this._computeTimeExtent(packets);

            console.log(`[DataSource] Legacy mode active: ${packets.length.toLocaleString()} packets`);

            return {
                mode: this.mode,
                timeExtent: this.timeExtent,
                packetCount: packets.length
            };
        }
    }

    /**
     * Initialize from CSV multi-resolution format (v3.0)
     * @private
     */
    async _initMultiResCSV(folderHandle) {
        const { csvResolutionManager } = await import('./csv-resolution-manager.js');

        console.log('[DataSource] Initializing CSV multi-resolution mode (v3.0)...');
        this.mode = 'multires-csv';
        this.csvResManager = csvResolutionManager;

        // Load manifest
        try {
            const manifestFile = await folderHandle.getFileHandle('manifest.json');
            const manifestText = await (await manifestFile.getFile()).text();
            this.manifest = JSON.parse(manifestText);
        } catch (err) {
            console.warn('[DataSource] Failed to load manifest:', err);
            this.manifest = {};
        }

        // Initialize CSV resolution manager
        const initialData = await csvResolutionManager.init(folderHandle);

        this.timeExtent = csvResolutionManager.timeExtent || [
            this.manifest.time_range?.start || 0,
            this.manifest.time_range?.end || 0
        ];
        this.packets = initialData;  // seconds-level data for initial view

        const packetCount = this.manifest.total_packets || initialData.length;

        console.log(`[DataSource] CSV multi-resolution mode active:`);
        console.log(`[DataSource]   Total packets: ${packetCount.toLocaleString()}`);
        console.log(`[DataSource]   Seconds bins: ${initialData.length.toLocaleString()}`);
        console.log(`[DataSource]   Time extent: [${this.timeExtent[0]}, ${this.timeExtent[1]}]`);

        return {
            mode: this.mode,
            timeExtent: this.timeExtent,
            packetCount: packetCount,
            hasPreAggregates: true,
            lazyLoaded: true,
            isMultiResCSV: true,
            csvResolutionManager: csvResolutionManager
        };
    }

    /**
     * Check manifest.json for format type
     * @private
     */
    async _checkManifestFormat(folderHandle) {
        try {
            const manifestFile = await folderHandle.getFileHandle('manifest.json');
            const manifestText = await (await manifestFile.getFile()).text();
            const manifest = JSON.parse(manifestText);
            console.log(`[DataSource] Manifest format: ${manifest.format || 'unknown'}, version: ${manifest.version || 'unknown'}`);
            return manifest.format || null;
        } catch {
            return null;
        }
    }

    /**
     * Get all packets (used by visualization initialization)
     * WARNING: This loads ALL data. For large datasets, use getMinuteAggregates() instead.
     * @returns {Promise<Array>} All packet data
     */
    async getAllPackets() {
        if (this.mode === 'duckdb') {
            // Load all packets from DuckDB
            return await DuckDBLoader.queryAllPackets(this.duckdbConn);
        } else {
            // Return already loaded packets
            return this.packets;
        }
    }

    /**
     * Get minute-level aggregates for fast initial load
     * Uses pre-aggregated parquet files if available (instant!)
     * Falls back to SQL query if not pre-aggregated
     * @returns {Promise<Array>} Minute-level aggregated data
     */
    async getMinuteAggregates() {
        if (this.mode === 'duckdb') {
            // Try pre-aggregated file first (MUCH faster)
            if (preAggregatesAvailable.minute && this.folderHandle) {
                return await DuckDBLoader.loadMinuteAggregatesFromFile(this.folderHandle);
            }
            // Fall back to SQL query
            return await DuckDBLoader.queryMinuteAggregates(this.duckdbConn);
        } else {
            // Legacy mode: aggregate in-memory packets
            return this._legacyMinuteAggregates();
        }
    }

    /**
     * Get second-level aggregates for medium zoom
     * Uses pre-aggregated parquet files if available (faster!)
     * Falls back to SQL query if not pre-aggregated
     * @param {[number, number]} timeRange - [start, end] timestamps
     * @returns {Promise<Array>} Second-level aggregated data
     */
    async getSecondAggregates(timeRange) {
        if (this.mode === 'duckdb') {
            // Try pre-aggregated file first (faster)
            if (preAggregatesAvailable.second && this.folderHandle) {
                return await DuckDBLoader.loadSecondAggregatesFromFile(this.folderHandle, timeRange);
            }
            // Fall back to SQL query
            return await DuckDBLoader.querySecondAggregates(this.duckdbConn, timeRange);
        } else {
            return this._legacySecondAggregates(timeRange);
        }
    }

    /**
     * Get resolution pyramid metadata if available
     * @returns {Object|null} Resolution metadata or null
     */
    getResolutionMetadata() {
        return preAggregatesAvailable.metadata;
    }

    /**
     * Check if pre-aggregated files are available
     * @returns {{minute: boolean, second: boolean}}
     */
    hasPreAggregates() {
        return {
            minute: preAggregatesAvailable.minute,
            second: preAggregatesAvailable.second
        };
    }

    /**
     * Get packets for a specific minute chunk (for detail loading)
     * @param {number} minuteStart - Start of minute in microseconds
     * @returns {Promise<Array>} Packets in that minute
     */
    async getMinuteChunk(minuteStart) {
        if (this.mode === 'duckdb') {
            return await DuckDBLoader.queryMinuteChunk(this.duckdbConn, minuteStart);
        } else {
            // Legacy: filter from in-memory packets
            const minuteEnd = minuteStart + 60000000;
            return this.packets.filter(p => 
                p.timestamp >= minuteStart && p.timestamp < minuteEnd
            );
        }
    }

    /**
     * Initialize the resolution manager for multi-resolution loading
     * @returns {Promise<Array>} Initial minute-level data
     */
    async initMultiResolution() {
        return await resolutionManager.init(this);
    }

    /**
     * Get data appropriate for current zoom level
     * @param {[number, number]} domain - Visible time domain
     * @returns {Promise<{data: Array, resolution: string, fromCache: boolean}>}
     */
    async getDataForZoom(domain) {
        return await resolutionManager.getDataForDomain(domain);
    }

    /**
     * Prefetch adjacent data for smooth zooming
     * @param {[number, number]} domain - Current visible domain
     */
    prefetchAdjacent(domain) {
        resolutionManager.prefetchAdjacent(domain);
    }

    /**
     * Get current resolution level
     * @returns {string} 'minute', 'second', or 'detail'
     */
    getCurrentResolution() {
        return resolutionManager.currentResolution;
    }

    /**
     * Get resolution manager memory stats
     * @returns {Object} Memory usage stats
     */
    getMemoryStats() {
        return resolutionManager.getMemoryStats();
    }

    /**
     * Get aggregated/binned data for a time range
     * @param {[number, number]} timeRange - [start, end] timestamps
     * @param {number} binCount - Number of bins
     * @returns {Promise<Array>} Binned packet data
     */
    async getAggregatedData(timeRange, binCount = 300) {
        if (this.mode === 'duckdb') {
            return DuckDBLoader.queryAggregated(this.duckdbConn, timeRange, binCount);
        } else {
            // Use legacy binning logic
            return this._legacyBinPackets(timeRange, binCount);
        }
    }

    /**
     * Get detailed packet data for a time range
     * @param {[number, number]} timeRange - [start, end] timestamps
     * @param {number} limit - Maximum packets to return
     * @returns {Promise<Array>} Detailed packet data
     */
    async getDetailData(timeRange, limit = 50000) {
        console.log(`[DataSource.getDetailData] mode=${this.mode}, timeRange=[${timeRange[0]}, ${timeRange[1]}], limit=${limit}`);
        if (this.mode === 'duckdb') {
            const result = await DuckDBLoader.queryDetail(this.duckdbConn, timeRange, limit);
            console.log(`[DataSource.getDetailData] DuckDB returned ${result?.length || 0} packets`);
            return result;
        } else {
            const result = this._legacyFilterPackets(timeRange, limit);
            console.log(`[DataSource.getDetailData] Legacy returned ${result?.length || 0} packets`);
            return result;
        }
    }

    /**
     * Load flows index
     * @returns {Promise<Array>} Flows index
     */
    async loadFlowsIndex() {
        if (!this.flowsIndex) {
            this.flowsIndex = await this.folderLoader.loadFlowsIndex();
        }
        return this.flowsIndex;
    }

    /**
     * Load IP statistics
     * @returns {Promise<Object>} IP statistics
     */
    async loadIPStats() {
        if (this.mode === 'duckdb' && !this.ipStats) {
            // Query from DuckDB
            this.ipStats = await DuckDBLoader.queryIPStats(this.duckdbConn);
        } else if (!this.ipStats) {
            // Load from file
            this.ipStats = await this.folderLoader.loadIPStats();
        }
        return this.ipStats;
    }

    /**
     * Load flag statistics
     * @returns {Promise<Object>} Flag statistics
     */
    async loadFlagStats() {
        if (this.mode === 'duckdb' && !this.flagStats) {
            // Query from DuckDB
            this.flagStats = await DuckDBLoader.queryFlagStats(this.duckdbConn);
        } else if (!this.flagStats) {
            // Load from file
            this.flagStats = await this.folderLoader.loadFlagStats();
        }
        return this.flagStats;
    }

    /**
     * Load a specific flow by ID
     * @param {string} flowId - Flow identifier
     * @returns {Promise<Object>} Flow data
     */
    async loadFlow(flowId) {
        return await this.folderLoader.loadFlow(flowId);
    }

    /**
     * Load multiple flows by IDs
     * @param {Array<string>} flowIds - Array of flow identifiers
     * @returns {Promise<Array>} Array of flow data
     */
    async loadFlows(flowIds) {
        return await this.folderLoader.loadFlows(flowIds);
    }

    /**
     * Filter flows by selected IPs
     * @param {Array<string>} selectedIPs - Array of IP addresses
     * @returns {Array} Filtered flows
     */
    filterFlowsByIPs(selectedIPs) {
        return this.folderLoader.filterFlowsByIPs(selectedIPs);
    }

    /**
     * Filter flows by time range
     * @param {number} startTime - Start timestamp
     * @param {number} endTime - End timestamp
     * @returns {Array} Filtered flows
     */
    filterFlowsByTimeRange(startTime, endTime) {
        return this.folderLoader.filterFlowsByTimeRange(startTime, endTime);
    }

    /**
     * Get summary information
     * @returns {Object} Summary data
     */
    getSummary() {
        return {
            mode: this.mode,
            timeExtent: this.timeExtent,
            manifest: this.manifest,
            ...this.folderLoader.getSummary()
        };
    }

    /**
     * Clear all cached data
     */
    clear() {
        this.mode = 'legacy';
        this.duckdbConn = null;
        this.timeExtent = null;
        this.folderHandle = null;
        this.manifest = null;
        this.packets = null;
        this.flowsIndex = null;
        this.ipStats = null;
        this.flagStats = null;
        this.folderLoader.clear();
    }

    // ========== PRIVATE METHODS ==========

    /**
     * Check if Parquet file is available in folder
     * @private
     */
    async _checkParquetAvailable(folderHandle) {
        try {
            await folderHandle.getFileHandle('packets.parquet');
            console.log('[DataSource] Parquet file detected');
            return true;
        } catch {
            console.log('[DataSource] No Parquet file found');
            return false;
        }
    }

    /**
     * Legacy binning implementation
     * @private
     */
    _legacyBinPackets(timeRange, binCount) {
        const [start, end] = timeRange;
        const binSize = Math.max(1, Math.floor((end - start) / binCount));

        // Filter packets in range
        const packetsInRange = this.packets.filter(
            p => p.timestamp >= start && p.timestamp <= end
        );

        // Bin packets
        const bins = new Map();

        for (const packet of packetsInRange) {
            const binStart = Math.floor(packet.timestamp / binSize) * binSize;
            const key = `${binStart}_${packet.src_ip}_${packet.dst_ip}_${packet.flags}`;

            if (!bins.has(key)) {
                bins.set(key, {
                    timestamp: binStart,
                    src_ip: packet.src_ip,
                    dst_ip: packet.dst_ip,
                    flags: packet.flags,
                    count: 0,
                    totalBytes: 0,
                    binned: true
                });
            }

            const bin = bins.get(key);
            bin.count++;
            bin.totalBytes += packet.length || 0;
        }

        return Array.from(bins.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Legacy minute-level aggregation
     * @private
     */
    _legacyMinuteAggregates() {
        if (!this.packets || this.packets.length === 0) return [];
        
        const minuteSize = 60000000; // 1 minute in microseconds
        const bins = new Map();

        for (const packet of this.packets) {
            const minuteBin = Math.floor(packet.timestamp / minuteSize) * minuteSize;
            const key = `${minuteBin}_${packet.src_ip}_${packet.dst_ip}_${packet.flags}`;

            if (!bins.has(key)) {
                bins.set(key, {
                    timestamp: minuteBin,
                    binStart: minuteBin,
                    binEnd: minuteBin + minuteSize,
                    src_ip: packet.src_ip,
                    dst_ip: packet.dst_ip,
                    flags: packet.flags,
                    count: 0,
                    totalBytes: 0,
                    minTimestamp: packet.timestamp,
                    maxTimestamp: packet.timestamp,
                    binned: true,
                    resolution: 'minute',
                    preBinnedSize: minuteSize,  // Mark as pre-binned with this bin size
                    binCenter: minuteBin + Math.floor(minuteSize / 2)  // Pre-compute bin center
                });
            }

            const bin = bins.get(key);
            bin.count++;
            bin.totalBytes += packet.length || 0;
            bin.minTimestamp = Math.min(bin.minTimestamp, packet.timestamp);
            bin.maxTimestamp = Math.max(bin.maxTimestamp, packet.timestamp);
        }

        return Array.from(bins.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Legacy second-level aggregation for a time range
     * @private
     */
    _legacySecondAggregates(timeRange) {
        const [start, end] = timeRange;
        const secondSize = 1000000; // 1 second in microseconds
        const bins = new Map();

        const packetsInRange = this.packets.filter(
            p => p.timestamp >= start && p.timestamp <= end
        );

        for (const packet of packetsInRange) {
            const secondBin = Math.floor(packet.timestamp / secondSize) * secondSize;
            const key = `${secondBin}_${packet.src_ip}_${packet.dst_ip}_${packet.flags}`;

            if (!bins.has(key)) {
                bins.set(key, {
                    timestamp: secondBin,
                    binStart: secondBin,
                    binEnd: secondBin + secondSize,
                    src_ip: packet.src_ip,
                    dst_ip: packet.dst_ip,
                    flags: packet.flags,
                    count: 0,
                    totalBytes: 0,
                    minTimestamp: packet.timestamp,
                    maxTimestamp: packet.timestamp,
                    binned: true,
                    resolution: 'second',
                    preBinnedSize: secondSize,  // Mark as pre-binned with this bin size
                    binCenter: secondBin + Math.floor(secondSize / 2)  // Pre-compute bin center
                });
            }

            const bin = bins.get(key);
            bin.count++;
            bin.totalBytes += packet.length || 0;
            bin.minTimestamp = Math.min(bin.minTimestamp, packet.timestamp);
            bin.maxTimestamp = Math.max(bin.maxTimestamp, packet.timestamp);
        }

        return Array.from(bins.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Legacy packet filtering implementation
     * @private
     */
    _legacyFilterPackets(timeRange, limit) {
        const [start, end] = timeRange;
        return this.packets
            .filter(p => p.timestamp >= start && p.timestamp <= end)
            .slice(0, limit);
    }

    /**
     * Compute time extent from packet array
     * @private
     */
    _computeTimeExtent(packets) {
        if (!packets || packets.length === 0) return [0, 0];

        let min = Infinity;
        let max = -Infinity;

        for (const p of packets) {
            if (p.timestamp < min) min = p.timestamp;
            if (p.timestamp > max) max = p.timestamp;
        }

        return [min, max];
    }
}

// Export singleton instance
export const dataSource = new DataSource();
