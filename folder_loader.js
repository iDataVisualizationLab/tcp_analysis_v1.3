/**
 * Folder-based data loader for TCP TimeArcs
 * Handles loading of split file structure:
 * - manifest.json: Dataset metadata
 * - packets.csv: Packet data for timearcs
 * - flows_index.json: Flow summaries
 * - flows/*.json: Individual flow files
 * - ip_stats.json: IP statistics
 * - flag_stats.json: Flag statistics
 */

export class FolderLoader {
    constructor() {
        this.folderHandle = null;
        this.manifest = null;
        this.packets = null;
        this.flowsIndex = null;
        this.ipStats = null;
        this.flagStats = null;
        this.loadedFlows = new Map(); // Cache for loaded flow files
    }

    /**
     * Open folder picker and load manifest
     */
    async openFolder() {
        try {
            // Use File System Access API to open folder
            this.folderHandle = await window.showDirectoryPicker({
                mode: 'read'
            });

            console.log(`Opened folder: ${this.folderHandle.name}`);

            // Verify we have read permission (especially important for external drives)
            const permission = await this.folderHandle.queryPermission({ mode: 'read' });
            console.log(`[FolderLoader] Initial permission status: ${permission}`);

            if (permission !== 'granted') {
                console.log('[FolderLoader] Requesting read permission...');
                const newPermission = await this.folderHandle.requestPermission({ mode: 'read' });
                console.log(`[FolderLoader] Permission after request: ${newPermission}`);

                if (newPermission !== 'granted') {
                    throw new Error('Read permission not granted for folder');
                }
            }

            // Debug: List what's accessible in the folder
            await this.listFolderContents();

            // Load manifest first
            await this.loadManifest();

            return {
                success: true,
                folderName: this.folderHandle.name,
                manifest: this.manifest
            };
        } catch (err) {
            if (err.name === 'AbortError') {
                console.log('Folder selection cancelled');
                return { success: false, cancelled: true };
            }
            console.error('Error opening folder:', err);
            throw err;
        }
    }

    /**
     * Debug helper: List accessible entries in folder
     */
    async listFolderContents(dirHandle = null) {
        const handle = dirHandle || this.folderHandle;
        const entries = [];
        try {
            for await (const entry of handle.values()) {
                entries.push({
                    name: entry.name,
                    kind: entry.kind
                });
            }
            console.log('[FolderLoader] Accessible entries:', entries);
            return entries;
        } catch (err) {
            console.error('[FolderLoader] Error listing folder contents:', err);
            return [];
        }
    }

    /**
     * Helper: Get subdirectory handle with better error reporting
     */
    async getSubdirectory(dirName) {
        try {
            console.log(`[FolderLoader] Attempting to access subdirectory: ${dirName}`);
            const dirHandle = await this.folderHandle.getDirectoryHandle(dirName);
            console.log(`[FolderLoader] Successfully accessed subdirectory: ${dirName}`);

            // Verify we can read from it by listing contents
            const entries = await this.listFolderContents(dirHandle);
            console.log(`[FolderLoader] Subdirectory ${dirName} contains ${entries.length} entries`);

            return dirHandle;
        } catch (err) {
            console.error(`[FolderLoader] Failed to access subdirectory ${dirName}:`, err.name, err.message);
            throw new Error(`Cannot access subdirectory '${dirName}': ${err.message}`);
        }
    }

    /**
     * Load manifest.json from folder
     */
    async loadManifest() {
        try {
            const manifestFile = await this.folderHandle.getFileHandle('manifest.json');
            const file = await manifestFile.getFile();
            const text = await file.text();
            this.manifest = JSON.parse(text);
            console.log('Loaded manifest:', this.manifest);
            return this.manifest;
        } catch (err) {
            console.error('Error loading manifest:', err);
            throw new Error('Could not load manifest.json from folder. Please ensure you selected a valid data folder.');
        }
    }

    /**
     * Load packets.csv for timearcs visualization
     */
    async loadPackets(onProgress = null) {
        try {
            const packetsFile = await this.folderHandle.getFileHandle('packets.csv');
            const file = await packetsFile.getFile();
            const text = await file.text();
            
            // Parse CSV with progress tracking
            this.packets = await this.parseCSVAsync(text, onProgress);
            
            console.log(`Loaded ${this.packets.length} packets`);
            return this.packets;
        } catch (err) {
            console.error('Error loading packets:', err);
            throw new Error('Could not load packets.csv from folder.');
        }
    }

    /**
     * Load flows_index.json
     * Supports both flows/flows_index.json (v2.0) and flows_index.json (v1.0)
     */
    async loadFlowsIndex() {
        try {
            // Try v3.0 chunked index first (best for large datasets)
            try {
                const flowsDir = await this.getSubdirectory('flows');
                const indexChunksDir = await flowsDir.getDirectoryHandle('index_chunks');
                const masterFile = await indexChunksDir.getFileHandle('flows_index_master.json');
                const file = await masterFile.getFile();
                const text = await file.text();
                const master = JSON.parse(text);

                console.log(`[FolderLoader] Found chunked index (v3.0): ${master.num_chunks} chunks, ${master.total_flows.toLocaleString()} flows`);
                console.log(`[FolderLoader] Loading flows progressively from ${master.num_chunks} chunks (${master.chunk_size.toLocaleString()} flows/chunk)...`);

                // Load all chunks progressively
                this.flowsIndex = [];
                const batchSize = 10; // Load 10 chunks at a time

                for (let i = 0; i < master.num_chunks; i += batchSize) {
                    const endIdx = Math.min(i + batchSize, master.num_chunks);
                    const chunkPromises = [];

                    for (let j = i; j < endIdx; j++) {
                        const chunkInfo = master.chunks[j];
                        const promise = (async () => {
                            const chunkFile = await indexChunksDir.getFileHandle(chunkInfo.file);
                            const f = await chunkFile.getFile();
                            const t = await f.text();
                            return JSON.parse(t);
                        })();
                        chunkPromises.push(promise);
                    }

                    const chunks = await Promise.all(chunkPromises);
                    for (const chunk of chunks) {
                        this.flowsIndex.push(...chunk);
                    }

                    console.log(`[FolderLoader] Loaded ${this.flowsIndex.length.toLocaleString()}/${master.total_flows.toLocaleString()} flows (${Math.round(this.flowsIndex.length / master.total_flows * 100)}%)`);
                }

                console.log(`[FolderLoader] ✓ Loaded all ${this.flowsIndex.length.toLocaleString()} flow summaries (v3.0 chunked index)`);
                return this.flowsIndex;
            } catch (err) {
                console.warn('[FolderLoader] v3.0 chunked index not found:', err.message);
            }

            // Fall back to v2.0 monolithic index
            try {
                const flowsDir = await this.getSubdirectory('flows');
                const indexFile = await flowsDir.getFileHandle('flows_index.json');
                console.log('[FolderLoader] Successfully got flows_index.json file handle');

                const file = await indexFile.getFile();
                const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
                console.log(`[FolderLoader] Reading flows_index.json (${fileSizeMB} MB)...`);

                // For large files, add progress indicator
                if (file.size > 50 * 1024 * 1024) { // > 50MB
                    console.warn(`[FolderLoader] Large file detected (${fileSizeMB} MB). This may take a moment...`);
                }

                const text = await file.text();
                console.log(`[FolderLoader] File read complete, parsing JSON...`);

                this.flowsIndex = JSON.parse(text);
                console.log(`[FolderLoader] Loaded ${this.flowsIndex.length} flow summaries (v2.0 monolithic format)`);
                return this.flowsIndex;
            } catch (err) {
                console.warn('[FolderLoader] v2.0 location failed:', err.message);

                // Check if it's a JSON parse error on a large file
                if (err.message.includes('JSON') || err.name === 'SyntaxError') {
                    throw new Error(`flows_index.json is too large or corrupted. Error: ${err.message}. Run create_chunked_flows_index.py to create chunked version.`);
                }

                console.log('[FolderLoader] Attempting fallback to v1.0 location (root)...');
                // Fall back to v1.0 location (flows_index.json at root)
                const indexFile = await this.folderHandle.getFileHandle('flows_index.json');
                const file = await indexFile.getFile();
                const text = await file.text();
                this.flowsIndex = JSON.parse(text);
                console.log(`[FolderLoader] Loaded ${this.flowsIndex.length} flow summaries (v1.0 individual format)`);
                return this.flowsIndex;
            }
        } catch (err) {
            console.error('[FolderLoader] All attempts failed:', err);
            throw new Error(`Could not load flows_index.json from folder. Error: ${err.message}`);
        }
    }

    /**
     * Load a specific flow by ID
     * Supports both chunked (v2.0) and individual (v1.0) formats
     */
    async loadFlow(flowId) {
        // Check cache first
        if (this.loadedFlows.has(flowId)) {
            return this.loadedFlows.get(flowId);
        }

        try {
            const flowSummary = this.flowsIndex.find(f => f.id === flowId);
            if (!flowSummary) {
                throw new Error(`Flow ${flowId} not found in index`);
            }

            // Check format version
            const isChunked = this.manifest?.format === 'chunked' || flowSummary.chunk_file;
            
            if (isChunked) {
                // v2.0 chunked format: load from chunk file
                return await this.loadFlowFromChunk(flowSummary);
            } else {
                // v1.0 individual format: load individual file
                return await this.loadFlowIndividual(flowId);
            }
        } catch (err) {
            console.error(`Error loading flow ${flowId}:`, err);
            throw err;
        }
    }

    /**
     * Load flow from chunk file (v2.0 format)
     */
    async loadFlowFromChunk(flowSummary) {
        const chunkFile = flowSummary.chunk_file;
        const chunkIndex = flowSummary.chunk_index;

        // Check if chunk is already cached
        const cacheKey = `chunk:${chunkFile}`;
        if (this.loadedFlows.has(cacheKey)) {
            const chunk = this.loadedFlows.get(cacheKey);
            const flow = chunk[chunkIndex];
            this.loadedFlows.set(flowSummary.id, flow);
            return flow;
        }

        // Load chunk file
        try {
            const flowsDir = await this.folderHandle.getDirectoryHandle('flows');
            const file = await flowsDir.getFileHandle(chunkFile);
            const fileObj = await file.getFile();
            const text = await fileObj.text();
            const chunk = JSON.parse(text);
            
            // Cache the entire chunk
            this.loadedFlows.set(cacheKey, chunk);
            
            // Get specific flow from chunk
            const flow = chunk[chunkIndex];
            this.loadedFlows.set(flowSummary.id, flow);
            
            return flow;
        } catch (err) {
            console.error(`Error loading chunk ${chunkFile}:`, err);
            throw new Error(`Could not load chunk file: ${chunkFile}`);
        }
    }

    /**
     * Load individual flow file (v1.0 format - backward compatibility)
     */
    async loadFlowIndividual(flowId) {
        try {
            const flowsDir = await this.folderHandle.getDirectoryHandle('flows');
            const flowFile = await flowsDir.getFileHandle(`${flowId}.json`);
            const file = await flowFile.getFile();
            const text = await file.text();
            const flow = JSON.parse(text);
            
            // Cache the flow
            this.loadedFlows.set(flowId, flow);
            
            return flow;
        } catch (err) {
            console.error(`Error loading flow ${flowId}:`, err);
            throw new Error(`Could not load flow file: ${flowId}.json`);
        }
    }

    /**
     * Load multiple flows by IDs
     */
    async loadFlows(flowIds) {
        const flows = [];
        for (const flowId of flowIds) {
            try {
                const flow = await this.loadFlow(flowId);
                flows.push(flow);
            } catch (err) {
                console.warn(`Failed to load flow ${flowId}:`, err);
            }
        }
        return flows;
    }

    /**
     * Load IP statistics
     * Supports both ips/ip_stats.json (v2.0) and ip_stats.json (v1.0)
     */
    async loadIPStats() {
        try {
            // Try v2.0 location first (ips/ip_stats.json)
            try {
                const ipsDir = await this.folderHandle.getDirectoryHandle('ips');
                const statsFile = await ipsDir.getFileHandle('ip_stats.json');
                const file = await statsFile.getFile();
                const text = await file.text();
                this.ipStats = JSON.parse(text);
                console.log(`Loaded IP statistics for ${Object.keys(this.ipStats).length} IPs`);
                return this.ipStats;
            } catch (err) {
                // Fall back to v1.0 location (ip_stats.json at root)
                const statsFile = await this.folderHandle.getFileHandle('ip_stats.json');
                const file = await statsFile.getFile();
                const text = await file.text();
                this.ipStats = JSON.parse(text);
                console.log(`Loaded IP statistics for ${Object.keys(this.ipStats).length} IPs`);
                return this.ipStats;
            }
        } catch (err) {
            console.error('Error loading IP stats:', err);
            throw new Error('Could not load ip_stats.json from folder.');
        }
    }

    /**
     * Load flag statistics
     * Supports both ips/flag_stats.json (v2.0) and flag_stats.json (v1.0)
     */
    async loadFlagStats() {
        try {
            // Try v2.0 location first (ips/flag_stats.json)
            try {
                const ipsDir = await this.folderHandle.getDirectoryHandle('ips');
                const statsFile = await ipsDir.getFileHandle('flag_stats.json');
                const file = await statsFile.getFile();
                const text = await file.text();
                this.flagStats = JSON.parse(text);
                console.log('Loaded flag statistics:', this.flagStats);
                return this.flagStats;
            } catch (err) {
                // Fall back to v1.0 location (flag_stats.json at root)
                const statsFile = await this.folderHandle.getFileHandle('flag_stats.json');
                const file = await statsFile.getFile();
                const text = await file.text();
                this.flagStats = JSON.parse(text);
                console.log('Loaded flag statistics:', this.flagStats);
                return this.flagStats;
            }
        } catch (err) {
            console.error('Error loading flag stats:', err);
            throw new Error('Could not load flag_stats.json from folder.');
        }
    }

    /**
     * Filter flows index by selected IPs
     */
    filterFlowsByIPs(selectedIPs) {
        if (!this.flowsIndex) {
            return [];
        }

        const ipSet = new Set(selectedIPs);
        return this.flowsIndex.filter(flow => {
            return ipSet.has(flow.initiator) && ipSet.has(flow.responder);
        });
    }

    /**
     * Get flows within a time range
     */
    filterFlowsByTimeRange(startTime, endTime) {
        if (!this.flowsIndex) {
            return [];
        }

        return this.flowsIndex.filter(flow => {
            return flow.startTime >= startTime && flow.endTime <= endTime;
        });
    }

    /**
     * Parse CSV asynchronously with progress tracking
     */
    async parseCSVAsync(csvText, onProgress = null) {
        return new Promise((resolve, reject) => {
            try {
                const lines = csvText.split('\n');
                const headers = lines[0].split(',').map(h => h.trim());
                const records = [];
                
                const totalLines = lines.length - 1;
                let processedLines = 0;
                
                // Process in chunks to allow UI updates
                const CHUNK_SIZE = 1000;
                let currentLine = 1;
                
                const processChunk = () => {
                    const endLine = Math.min(currentLine + CHUNK_SIZE, lines.length);
                    
                    for (let i = currentLine; i < endLine; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        
                        const values = line.split(',');
                        const record = {};
                        
                        headers.forEach((header, idx) => {
                            const value = values[idx] ? values[idx].trim() : '';
                            
                            // Parse specific fields
                            if (['timestamp', 'src_port', 'dst_port', 'flags', 'seq_num', 'ack_num', 'length', 'protocol'].includes(header)) {
                                record[header] = value ? parseInt(value) : 0;
                            } else if (header === 'flags') {
                                // Parse flag bits
                                const flagBits = parseInt(value) || 0;
                                record.flags = {
                                    fin: (flagBits & 0x01) !== 0,
                                    syn: (flagBits & 0x02) !== 0,
                                    rst: (flagBits & 0x04) !== 0,
                                    psh: (flagBits & 0x08) !== 0,
                                    ack: (flagBits & 0x10) !== 0,
                                    urg: (flagBits & 0x20) !== 0,
                                    ece: (flagBits & 0x40) !== 0,
                                    cwr: (flagBits & 0x80) !== 0
                                };
                            } else {
                                record[header] = value;
                            }
                        });
                        
                        records.push(record);
                        processedLines++;
                    }
                    
                    // Report progress
                    if (onProgress) {
                        const progress = (processedLines / totalLines) * 100;
                        onProgress(progress, processedLines, totalLines);
                    }
                    
                    currentLine = endLine;
                    
                    if (currentLine < lines.length) {
                        // Schedule next chunk
                        setTimeout(processChunk, 0);
                    } else {
                        // Done
                        resolve(records);
                    }
                };
                
                // Start processing
                processChunk();
                
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Clear all cached data
     */
    clear() {
        this.folderHandle = null;
        this.manifest = null;
        this.packets = null;
        this.flowsIndex = null;
        this.ipStats = null;
        this.flagStats = null;
        this.loadedFlows.clear();
    }

    /**
     * Get summary information
     */
    getSummary() {
        return {
            folderOpen: this.folderHandle !== null,
            folderName: this.folderHandle?.name || null,
            manifest: this.manifest,
            packetsLoaded: this.packets?.length || 0,
            flowsIndexLoaded: this.flowsIndex?.length || 0,
            flowsCached: this.loadedFlows.size,
            ipStatsLoaded: this.ipStats ? Object.keys(this.ipStats).length : 0,
            flagStatsLoaded: this.flagStats ? Object.keys(this.flagStats).length : 0
        };
    }
}

// Export singleton instance
export const folderLoader = new FolderLoader();
