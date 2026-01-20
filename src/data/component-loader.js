// src/data/component-loader.js - Component-aware data loading for attack traffic analysis
// Loads connected components from preprocessed Parquet files

import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let db = null;
let conn = null;

/**
 * Component Loader - manages loading and querying of component-partitioned Parquet files
 */
class ComponentLoader {
    constructor() {
        this.componentIndex = null;
        this.ipToComponent = new Map();
        this.loadedComponents = new Map();  // component_id -> { tableName, loaded }
        this.folderHandle = null;
        this.initialized = false;
    }

    /**
     * Initialize component loader from folder
     * @param {FileSystemDirectoryHandle} folderHandle - Folder containing components/
     * @param {AsyncDuckDBConnection} duckdbConn - Optional existing DuckDB connection
     * @returns {Promise<Object|null>} Component index or null if not available
     */
    async init(folderHandle, duckdbConn = null) {
        this.folderHandle = folderHandle;

        // Use provided connection or initialize new one
        if (duckdbConn) {
            conn = duckdbConn;
        } else if (!conn) {
            await this._initDuckDB();
        }

        try {
            const componentsDir = await folderHandle.getDirectoryHandle('components');
            const indexFile = await componentsDir.getFileHandle('components_index.json');
            const file = await indexFile.getFile();
            const text = await file.text();
            this.componentIndex = JSON.parse(text);

            // Build IP lookup map
            if (this.componentIndex.ip_to_component) {
                for (const [ip, compId] of Object.entries(this.componentIndex.ip_to_component)) {
                    this.ipToComponent.set(ip, compId);
                }
            }

            this.initialized = true;
            console.log(`[ComponentLoader] Loaded ${this.componentIndex.total_components} attack components`);
            console.log(`[ComponentLoader] Detection basis: ${this.componentIndex.detection_basis}`);
            console.log(`[ComponentLoader] Isolated IPs: ${this.componentIndex.isolated_ips?.length || 0}`);

            return this.componentIndex;
        } catch (err) {
            console.warn('[ComponentLoader] No component index found:', err.message);
            this.initialized = false;
            return null;
        }
    }

    /**
     * Initialize DuckDB if not already done
     * @private
     */
    async _initDuckDB() {
        if (db) return;

        console.log('[ComponentLoader] Initializing DuckDB WASM...');

        const bundle = {
            mainModule: '/vendor/duckdb-wasm/duckdb-eh.wasm',
            mainWorker: '/vendor/duckdb-wasm/duckdb-browser-eh.worker.js',
            pthreadWorker: '/vendor/duckdb-wasm/duckdb-browser-eh.pthread.worker.js'
        };

        const worker = new Worker(bundle.mainWorker);
        const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);

        db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        conn = await db.connect();

        console.log('[ComponentLoader] DuckDB initialized');
    }

    /**
     * Check if component loader is initialized and has components
     * @returns {boolean}
     */
    isAvailable() {
        return this.initialized && this.componentIndex && this.componentIndex.total_components > 0;
    }

    /**
     * Find components containing given IPs
     * @param {string[]} ips - Array of IP addresses
     * @returns {number[]} - Array of component IDs (excludes -1 for isolated IPs)
     */
    getComponentsForIPs(ips) {
        const componentIds = new Set();
        for (const ip of ips) {
            const compId = this.ipToComponent.get(ip);
            if (compId !== undefined && compId >= 0) {
                componentIds.add(compId);
            }
        }
        return Array.from(componentIds);
    }

    /**
     * Get all IPs that belong to any attack component (not isolated)
     * @returns {string[]}
     */
    getAttackIPs() {
        const attackIPs = [];
        for (const [ip, compId] of this.ipToComponent) {
            if (compId >= 0) {
                attackIPs.push(ip);
            }
        }
        return attackIPs;
    }

    /**
     * Query packets for specific components within a time window
     * @param {number[]} componentIds - Component IDs to query
     * @param {[number, number]} timeRange - [startTime, endTime] in microseconds
     * @param {number} limit - Max packets to return (default 100000)
     * @returns {Promise<Object[]>} Array of packet objects
     */
    async queryComponentPackets(componentIds, timeRange, limit = 100000) {
        if (!this.isAvailable()) {
            console.warn('[ComponentLoader] Not initialized or no components available');
            return [];
        }

        const [startTime, endTime] = timeRange;
        const results = [];
        const limitPerComponent = Math.ceil(limit / componentIds.length);

        console.log(`[ComponentLoader] Querying ${componentIds.length} components for time range [${startTime}, ${endTime}]`);

        for (const compId of componentIds) {
            const compInfo = this.componentIndex.components.find(c => c.id === compId);
            if (!compInfo) {
                console.warn(`[ComponentLoader] Component ${compId} not found in index`);
                continue;
            }

            // Check if time ranges overlap
            const [compStart, compEnd] = compInfo.time_extent;
            if (compEnd < startTime || compStart > endTime) {
                console.log(`[ComponentLoader] Component ${compId} outside time range, skipping`);
                continue;
            }

            // Load component parquet if not cached
            if (!this.loadedComponents.has(compId)) {
                await this._loadComponentParquet(compId, compInfo.file);
            }

            // Query with time filter
            const compData = await this._queryComponentTimeRange(compId, timeRange, limitPerComponent);
            results.push(...compData);

            console.log(`[ComponentLoader] Component ${compId}: ${compData.length} packets`);
        }

        // Sort combined results by timestamp
        results.sort((a, b) => a.timestamp - b.timestamp);

        // Apply total limit
        const finalResults = results.slice(0, limit);
        console.log(`[ComponentLoader] Total: ${finalResults.length} packets (from ${results.length})`);

        return finalResults;
    }

    /**
     * Query minute-level aggregates for components
     * @param {number[]} componentIds - Component IDs to query
     * @param {[number, number]} timeRange - [startTime, endTime] in microseconds
     * @returns {Promise<Object[]>} Array of aggregate objects
     */
    async queryComponentMinuteAggregates(componentIds, timeRange) {
        if (!this.isAvailable()) return [];

        const [startTime, endTime] = timeRange;
        const results = [];

        for (const compId of componentIds) {
            const compInfo = this.componentIndex.components.find(c => c.id === compId);
            if (!compInfo || !compInfo.aggregates?.minute) continue;

            // Check time overlap
            const [compStart, compEnd] = compInfo.time_extent;
            if (compEnd < startTime || compStart > endTime) continue;

            // Load minute aggregates
            const tableName = `comp_${compId}_minute`;
            if (!this.loadedComponents.has(tableName)) {
                await this._loadAggregateParquet(compId, 'minute', compInfo.aggregates.minute);
            }

            const aggData = await this._queryAggregateTimeRange(tableName, timeRange);
            results.push(...aggData);
        }

        return results.sort((a, b) => a.bin_start - b.bin_start);
    }

    /**
     * Query second-level aggregates for components
     * @param {number[]} componentIds - Component IDs to query
     * @param {[number, number]} timeRange - [startTime, endTime] in microseconds
     * @returns {Promise<Object[]>} Array of aggregate objects
     */
    async queryComponentSecondAggregates(componentIds, timeRange) {
        if (!this.isAvailable()) return [];

        const [startTime, endTime] = timeRange;
        const results = [];

        for (const compId of componentIds) {
            const compInfo = this.componentIndex.components.find(c => c.id === compId);
            if (!compInfo || !compInfo.aggregates?.second) continue;

            // Check time overlap
            const [compStart, compEnd] = compInfo.time_extent;
            if (compEnd < startTime || compStart > endTime) continue;

            // Load second aggregates
            const tableName = `comp_${compId}_second`;
            if (!this.loadedComponents.has(tableName)) {
                await this._loadAggregateParquet(compId, 'second', compInfo.aggregates.second);
            }

            const aggData = await this._queryAggregateTimeRange(tableName, timeRange);
            results.push(...aggData);
        }

        return results.sort((a, b) => a.bin_start - b.bin_start);
    }

    /**
     * Load component parquet file into DuckDB
     * @private
     */
    async _loadComponentParquet(compId, filePath) {
        if (!db) await this._initDuckDB();

        console.log(`[ComponentLoader] Loading component ${compId} parquet...`);

        try {
            const componentsDir = await this.folderHandle.getDirectoryHandle('components');
            const fileName = filePath.split('/').pop();
            const fileHandle = await componentsDir.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            const buffer = await file.arrayBuffer();

            const tableName = `component_${compId}`;
            await db.registerFileBuffer(`${tableName}.parquet`, new Uint8Array(buffer));
            await conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM '${tableName}.parquet'`);

            this.loadedComponents.set(compId, { tableName, loaded: true });
            console.log(`[ComponentLoader] Loaded component ${compId} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
        } catch (err) {
            console.error(`[ComponentLoader] Failed to load component ${compId}:`, err);
            throw err;
        }
    }

    /**
     * Load aggregate parquet file into DuckDB
     * @private
     */
    async _loadAggregateParquet(compId, level, filePath) {
        if (!db) await this._initDuckDB();

        console.log(`[ComponentLoader] Loading component ${compId} ${level} aggregates...`);

        try {
            const componentsDir = await this.folderHandle.getDirectoryHandle('components');
            const aggDir = await componentsDir.getDirectoryHandle('aggregates');
            const fileName = filePath.split('/').pop();
            const fileHandle = await aggDir.getFileHandle(fileName);
            const file = await fileHandle.getFile();
            const buffer = await file.arrayBuffer();

            const tableName = `comp_${compId}_${level}`;
            await db.registerFileBuffer(`${tableName}.parquet`, new Uint8Array(buffer));
            await conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM '${tableName}.parquet'`);

            this.loadedComponents.set(tableName, { tableName, loaded: true });
            console.log(`[ComponentLoader] Loaded ${tableName} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
        } catch (err) {
            console.error(`[ComponentLoader] Failed to load ${level} aggregates for component ${compId}:`, err);
        }
    }

    /**
     * Query time range from loaded component
     * @private
     */
    async _queryComponentTimeRange(compId, timeRange, limit) {
        const [start, end] = timeRange;
        const tableName = `component_${compId}`;

        try {
            const result = await conn.query(`
                SELECT * FROM ${tableName}
                WHERE timestamp >= ${start} AND timestamp <= ${end}
                ORDER BY timestamp
                LIMIT ${limit}
            `);

            return result.toArray().map(row => ({
                timestamp: Number(row.timestamp),
                src_ip: row.src_ip,
                dst_ip: row.dst_ip,
                src_port: Number(row.src_port),
                dst_port: Number(row.dst_port),
                flags: Number(row.flags),
                flag_type: row.flag_type,
                length: Number(row.length),
                component_id: Number(row.component_id)
            }));
        } catch (err) {
            console.error(`[ComponentLoader] Query failed for component ${compId}:`, err);
            return [];
        }
    }

    /**
     * Query aggregate time range
     * @private
     */
    async _queryAggregateTimeRange(tableName, timeRange) {
        const [start, end] = timeRange;

        try {
            const result = await conn.query(`
                SELECT * FROM ${tableName}
                WHERE bin_end >= ${start} AND bin_start <= ${end}
                ORDER BY bin_start
            `);

            return result.toArray().map(row => ({
                bin_start: Number(row.bin_start),
                bin_end: Number(row.bin_end),
                src_ip: row.src_ip,
                dst_ip: row.dst_ip,
                flags: Number(row.flags),
                flag_type: row.flag_type,
                packet_count: Number(row.packet_count),
                total_bytes: Number(row.total_bytes),
                min_ts: Number(row.min_ts),
                max_ts: Number(row.max_ts)
            }));
        } catch (err) {
            console.error(`[ComponentLoader] Aggregate query failed for ${tableName}:`, err);
            return [];
        }
    }

    /**
     * Get component metadata by ID
     * @param {number} compId - Component ID
     * @returns {Object|null} Component info object
     */
    getComponentInfo(compId) {
        return this.componentIndex?.components.find(c => c.id === compId) || null;
    }

    /**
     * Get all IPs in a component
     * @param {number} compId - Component ID
     * @returns {string[]} Array of IP addresses
     */
    getComponentIPs(compId) {
        const compInfo = this.getComponentInfo(compId);
        return compInfo?.ips || [];
    }

    /**
     * Get all components sorted by packet count
     * @returns {Object[]} Array of component info objects
     */
    getAllComponents() {
        if (!this.componentIndex?.components) return [];
        return [...this.componentIndex.components].sort((a, b) => b.packet_count - a.packet_count);
    }

    /**
     * Get summary statistics
     * @returns {Object}
     */
    getSummary() {
        if (!this.componentIndex) return null;

        const totalPackets = this.componentIndex.components.reduce((sum, c) => sum + c.packet_count, 0);
        const totalIPs = this.componentIndex.components.reduce((sum, c) => sum + c.ip_count, 0);

        return {
            totalComponents: this.componentIndex.total_components,
            totalPackets,
            totalIPs,
            isolatedIPs: this.componentIndex.isolated_ips?.length || 0,
            detectionBasis: this.componentIndex.detection_basis
        };
    }

    /**
     * Clear all loaded component data from memory
     */
    clearCache() {
        this.loadedComponents.clear();
        console.log('[ComponentLoader] Cache cleared');
    }

    /**
     * Reset the component loader completely
     */
    reset() {
        this.componentIndex = null;
        this.ipToComponent.clear();
        this.loadedComponents.clear();
        this.folderHandle = null;
        this.initialized = false;
        console.log('[ComponentLoader] Reset complete');
    }
}

// Export singleton instance
export const componentLoader = new ComponentLoader();

// Also export the class for testing
export { ComponentLoader };
