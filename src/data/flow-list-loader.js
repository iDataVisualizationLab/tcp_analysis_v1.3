// src/data/flow-list-loader.js
// Loads flow_list CSV files for flow list popup with embedded packet data

/**
 * Infer packet direction based on TCP flags and flow state
 * Returns true if packet is from initiator to responder, false otherwise
 *
 * TCP Handshake:
 *   1. SYN (initiator → responder)
 *   2. SYN+ACK (responder → initiator)
 *   3. ACK (initiator → responder)
 *
 * @param {number} flags - TCP flags
 * @param {Object} state - Mutable state object tracking handshake progress
 * @returns {boolean} true if initiator→responder, false if responder→initiator
 */
function inferPacketDirection(flags, state) {
    const SYN = 0x02;
    const ACK = 0x10;
    const FIN = 0x01;
    const RST = 0x04;
    const PSH = 0x08;

    const isSyn = (flags & SYN) !== 0;
    const isAck = (flags & ACK) !== 0;
    const isFin = (flags & FIN) !== 0;
    const isRst = (flags & RST) !== 0;
    const isPsh = (flags & PSH) !== 0;

    // SYN without ACK = initiator starting connection
    if (isSyn && !isAck) {
        state.handshakeStep = 1;
        state.lastDirection = true; // initiator → responder
        return true;
    }

    // SYN+ACK = responder responding
    if (isSyn && isAck) {
        state.handshakeStep = 2;
        state.lastDirection = false; // responder → initiator
        return false;
    }

    // After SYN+ACK, first ACK-only completes handshake (from initiator)
    if (state.handshakeStep === 2 && isAck && !isSyn && !isFin && !isRst && !isPsh) {
        state.handshakeStep = 3;
        state.lastDirection = true;
        return true;
    }

    // RST can come from either side - alternate from last
    if (isRst) {
        state.lastDirection = !state.lastDirection;
        return state.lastDirection;
    }

    // FIN packets - first FIN could be from either side, subsequent alternate
    if (isFin) {
        if (!state.finSeen) {
            state.finSeen = true;
            // First FIN - could be from either side, use heuristic
            state.lastDirection = !state.lastDirection;
        } else {
            state.lastDirection = !state.lastDirection;
        }
        return state.lastDirection;
    }

    // Data packets (PSH+ACK or just ACK) - alternate direction
    // This is a simplification; real flows may have multiple packets in same direction
    state.lastDirection = !state.lastDirection;
    return state.lastDirection;
}

/**
 * Parse the fp (flow packets) column into an array of packet objects
 * Format: delta_ts:length:flags:dir:seq:ack,...
 * dir: 1=initiator->responder, 0=responder->initiator
 * seq/ack: absolute sequence and acknowledgment numbers
 *
 * @param {string} fpString - The fp column value
 * @param {number} flowStartTime - The flow's start time in microseconds
 * @param {Object} flowMeta - Flow metadata (initiator, responder, ports)
 * @returns {Array} Array of packet objects
 */
function parseFlowPackets(fpString, flowStartTime, flowMeta) {
    if (!fpString || typeof fpString !== 'string' || fpString.trim() === '') {
        return [];
    }

    const packets = [];
    const parts = fpString.split(',');

    // State for tracking TCP direction (fallback when dir not in CSV)
    const directionState = {
        handshakeStep: 0,
        lastDirection: true, // true = initiator→responder
        finSeen: false
    };

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;

        const fields = part.split(':');
        const delta = parseInt(fields[0], 10) || 0;
        const length = parseInt(fields[1], 10) || 0;
        const flags = parseInt(fields[2], 10) || 0;

        // Use explicit direction if present (4th field), otherwise infer from flags
        let isFromInitiator;
        if (fields.length >= 4) {
            // Explicit direction from CSV: 1 = initiator->responder, 0 = responder->initiator
            isFromInitiator = fields[3] === '1';
        } else {
            // Fallback: infer direction based on TCP flags (for old CSV format)
            isFromInitiator = inferPacketDirection(flags, directionState);
        }

        // Parse absolute seq/ack values
        let seq_num = null;
        let ack_num = null;

        if (fields.length >= 6) {
            seq_num = parseInt(fields[4], 10) || 0;
            ack_num = parseInt(fields[5], 10) || 0;
        }

        // Set src/dst based on direction
        const src_ip = isFromInitiator ? flowMeta.initiator : flowMeta.responder;
        const dst_ip = isFromInitiator ? flowMeta.responder : flowMeta.initiator;
        const src_port = isFromInitiator ? flowMeta.initiatorPort : flowMeta.responderPort;
        const dst_port = isFromInitiator ? flowMeta.responderPort : flowMeta.initiatorPort;

        packets.push({
            timestamp: flowStartTime + delta,
            length: length,
            flags: flags,
            src_ip: src_ip,
            dst_ip: dst_ip,
            src_port: src_port,
            dst_port: dst_port,
            seq_num: seq_num,
            ack_num: ack_num,
            _index: i,
            _fromInitiator: isFromInitiator
        });
    }

    return packets;
}

/**
 * Parse a CSV row into a flow object
 * CSV columns: d,st,et,p,sp,dp,ct,fp
 * Note: d is direction flag (0 = first IP alphabetically is initiator, 1 = second)
 * Note: et is stored as duration (delta), not absolute end time
 * Note: ct contains close type (graceful/abortive/ongoing) or invalid reason directly
 * @param {string[]} row - CSV row fields
 * @param {number} index - Row index for ID
 * @param {string} ip1 - First IP (alphabetically) from filename
 * @param {string} ip2 - Second IP (alphabetically) from filename
 */
function parseFlowRow(row, index, ip1, ip2) {
    const [d, st, et, p, sp, dp, ct, fp] = row;
    const direction = parseInt(d, 10) || 0;
    const startTime = parseInt(st, 10);
    const duration = parseInt(et, 10) || 0;
    const endTime = startTime + duration;  // Reconstruct absolute end time
    const initiatorPort = parseInt(sp, 10) || 0;
    const responderPort = parseInt(dp, 10) || 0;

    // Derive initiator/responder from direction flag and IP pair
    const initiator = direction === 0 ? ip1 : ip2;
    const responder = direction === 0 ? ip2 : ip1;

    // Parse embedded packets if fp column exists
    const flowMeta = {
        initiator: initiator,
        responder: responder,
        initiatorPort: initiatorPort,
        responderPort: responderPort
    };
    const embeddedPackets = fp ? parseFlowPackets(fp, startTime, flowMeta) : [];

    // Calculate total bytes from embedded packets if available
    const totalBytes = embeddedPackets.length > 0
        ? embeddedPackets.reduce((sum, pkt) => sum + pkt.length, 0)
        : 0;

    // ct contains either close type (graceful/abortive/ongoing) or invalid reason
    const normalCloseTypes = ['graceful', 'abortive', 'ongoing', ''];
    const isInvalid = ct && !normalCloseTypes.includes(ct);
    const closeType = isInvalid ? 'invalid' : (ct || '');
    const invalidReason = isInvalid ? ct : '';

    return {
        id: index,
        initiator: initiator,
        responder: responder,
        startTime: startTime,
        endTime: endTime,
        totalPackets: parseInt(p, 10),
        initiatorPort: initiatorPort,
        responderPort: responderPort,
        closeType: closeType,
        invalidReason: invalidReason,
        // Derived fields for compatibility
        totalBytes: totalBytes,
        state: isInvalid ? 'invalid' : (ct ? 'closed' : 'unknown'),
        establishmentComplete: closeType === 'graceful' || closeType === 'abortive',
        // Embedded packet data from fp column
        _embeddedPackets: embeddedPackets,
        _hasEmbeddedPackets: embeddedPackets.length > 0,
        // Store raw fp for debugging
        _fpRaw: fp || ''
    };
}

/**
 * Parse a CSV line handling quoted fields (for fp column with commas)
 * @param {string} line - CSV line
 * @returns {string[]} Array of field values
 */
function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            // Toggle quote state (handle escaped quotes "")
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++; // Skip next quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    fields.push(current); // Don't forget the last field
    return fields;
}

/**
 * Parse CSV text into array of flow objects
 * Handles the fp column which contains comma-separated packet data (quoted)
 * @param {string} csvText - CSV file content
 * @param {string} ip1 - First IP (alphabetically) from filename
 * @param {string} ip2 - Second IP (alphabetically) from filename
 */
function parseFlowCSV(csvText, ip1, ip2) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    // Skip header row
    const flows = [];
    for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i]);
        if (row.length >= 4) {  // At least d,st,et,p
            flows.push(parseFlowRow(row, i - 1, ip1, ip2));
        }
    }
    return flows;
}

/**
 * Flow list loader - manages loading and filtering of flow summaries
 * Used when chunk files are not available (e.g., GitHub deployment)
 */
export class FlowListLoader {
    constructor() {
        this.index = null;
        this.pairsByKey = null;  // Map of ip_pair -> { file, count, loaded, flows }
        this.metadata = null;
        this.basePath = null;
        this.loaded = false;
        this.loading = false;
        this.loadPromise = null;
    }

    /**
     * Load flow_list index.json from the specified base path
     * @param {string} basePath - Base path to the data directory
     * @returns {Promise<boolean>} - True if loaded successfully
     */
    async load(basePath) {
        if (this.loaded) return true;
        if (this.loading) return this.loadPromise;

        this.loading = true;
        this.basePath = basePath;
        this.loadPromise = this._doLoad(basePath);

        try {
            await this.loadPromise;
            return this.loaded;
        } finally {
            this.loading = false;
        }
    }

    async _doLoad(basePath) {
        const url = `${basePath}/indices/flow_list/index.json`;
        console.log(`[FlowListLoader] Loading ${url}...`);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                console.warn(`[FlowListLoader] No index.json found at ${url}`);
                return;
            }
            this.index = await response.json();
            this.flowListPath = `${basePath}/indices/flow_list`;
        } catch (err) {
            console.warn(`[FlowListLoader] Failed to load index.json:`, err);
            return false;
        }

        try {
            this.metadata = {
                version: this.index.version,
                format: this.index.format,
                columns: this.index.columns,
                totalFlows: this.index.total_flows,
                totalPairs: this.index.total_pairs,
                uniqueIPs: this.index.unique_ips,
                timeRange: this.index.time_range
            };

            // Build lookup by IP pair, grouping split files
            this.pairsByKey = new Map();
            let splitPairsCount = 0;

            for (const pairInfo of this.index.pairs) {
                const pairKey = pairInfo.pair;

                if (!this.pairsByKey.has(pairKey)) {
                    // First entry for this pair
                    this.pairsByKey.set(pairKey, {
                        files: [],  // Array of {file, count, part, total_parts}
                        totalCount: 0,
                        loaded: false,
                        flows: null
                    });
                }

                const entry = this.pairsByKey.get(pairKey);
                entry.files.push({
                    file: pairInfo.file,
                    count: pairInfo.count,
                    part: pairInfo.part || null,
                    total_parts: pairInfo.total_parts || null
                });
                entry.totalCount += pairInfo.count;

                if (pairInfo.total_parts && pairInfo.total_parts > 1) {
                    splitPairsCount++;
                }
            }

            this.loaded = true;
            const hasFpColumn = this.index.columns && this.index.columns.includes('fp');
            const uniquePairs = this.pairsByKey.size;
            const splitPairs = [...this.pairsByKey.values()].filter(p => p.files.length > 1).length;

            console.log(`[FlowListLoader] Index loaded from ${url}`);
            console.log(`[FlowListLoader]   ${uniquePairs} IP pairs, ${this.index.total_flows.toLocaleString()} total flows`);
            if (splitPairs > 0) {
                console.log(`[FlowListLoader]   ${splitPairs} pairs split into multiple files`);
            }
            if (hasFpColumn) {
                console.log(`[FlowListLoader] ✓ fp column detected - embedded packet data available for visualization`);
            } else {
                console.log(`[FlowListLoader] No fp column - packet visualization will require chunk files`);
            }
            return true;

        } catch (err) {
            console.error('[FlowListLoader] Error loading index.json:', err);
            return false;
        }
    }

    /**
     * Check if flow list index is loaded
     * @returns {boolean}
     */
    isLoaded() {
        return this.loaded;
    }

    /**
     * Get metadata about the loaded flow list
     * @returns {Object|null}
     */
    getMetadata() {
        return this.metadata;
    }

    /**
     * Get time range of all flows
     * @returns {[number, number]|null}
     */
    getTimeRange() {
        if (!this.metadata || !this.metadata.timeRange) return null;
        return [this.metadata.timeRange.start, this.metadata.timeRange.end];
    }

    /**
     * Normalize IP pair key (alphabetically sorted)
     */
    _normalizeIPPair(ip1, ip2) {
        return ip1 < ip2 ? `${ip1}<->${ip2}` : `${ip2}<->${ip1}`;
    }

    /**
     * Get all IP pairs that involve the given IPs
     * @param {string[]} selectedIPs - Array of selected IPs
     * @returns {string[]} Array of IP pair keys
     */
    _getRelevantPairs(selectedIPs) {
        if (!this.pairsByKey) return [];

        const selectedSet = new Set(selectedIPs);
        const relevantPairs = [];

        for (const [pairKey, pairInfo] of this.pairsByKey) {
            // Parse IP pair key: "ip1<->ip2"
            const [ip1, ip2] = pairKey.split('<->');
            // Both IPs must be selected
            if (selectedSet.has(ip1) && selectedSet.has(ip2)) {
                relevantPairs.push(pairKey);
            }
        }

        return relevantPairs;
    }

    /**
     * Load flows for a specific IP pair (handles split files)
     * @param {string} pairKey - IP pair key like "ip1<->ip2" (alphabetically sorted)
     * @returns {Promise<Array>} Array of flow objects
     */
    async _loadPairFlows(pairKey) {
        const pairInfo = this.pairsByKey.get(pairKey);
        if (!pairInfo) return [];

        // Return cached if already loaded
        if (pairInfo.loaded && pairInfo.flows) {
            return pairInfo.flows;
        }

        // Extract IPs from pair key (format: "ip1<->ip2" where ip1 < ip2)
        const [ip1, ip2] = pairKey.split('<->');

        // Load all files for this pair (may be split into multiple parts)
        const allFlows = [];
        let flowIdOffset = 0;

        // Sort files by part number to ensure correct order
        const sortedFiles = [...pairInfo.files].sort((a, b) => {
            if (a.part && b.part) return a.part - b.part;
            return 0;
        });

        const isSplit = sortedFiles.length > 1;
        if (isSplit) {
            console.log(`[FlowListLoader] Loading ${sortedFiles.length} parts for ${pairKey}...`);
        }

        for (const fileInfo of sortedFiles) {
            const url = `${this.flowListPath}/${fileInfo.file}`;
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    console.warn(`[FlowListLoader] Failed to load ${fileInfo.file}: ${response.status}`);
                    continue;
                }

                const csvText = await response.text();
                const flows = parseFlowCSV(csvText, ip1, ip2);

                // Adjust flow IDs to be unique across parts
                for (const flow of flows) {
                    flow.id = flowIdOffset + flow.id;
                }
                flowIdOffset += flows.length;

                // Use loop instead of spread to avoid stack overflow with large arrays
                for (let i = 0; i < flows.length; i++) {
                    allFlows.push(flows[i]);
                }

                if (isSplit) {
                    console.log(`[FlowListLoader]   Part ${fileInfo.part}/${fileInfo.total_parts}: ${flows.length} flows`);
                }

            } catch (err) {
                console.error(`[FlowListLoader] Error loading ${fileInfo.file}:`, err);
            }
        }

        // Cache the result
        pairInfo.loaded = true;
        pairInfo.flows = allFlows;

        // Count flows with embedded packet data
        const flowsWithPackets = allFlows.filter(f => f._hasEmbeddedPackets).length;
        const totalPackets = allFlows.reduce((sum, f) => sum + (f._embeddedPackets?.length || 0), 0);

        const fileDesc = isSplit ? `${sortedFiles.length} files` : sortedFiles[0]?.file || 'unknown';
        if (flowsWithPackets > 0) {
            console.log(`[FlowListLoader] ✓ Loaded ${allFlows.length} flows from ${fileDesc} (${flowsWithPackets} with embedded packets, ${totalPackets} total packets)`);
        } else {
            console.log(`[FlowListLoader] Loaded ${allFlows.length} flows from ${fileDesc} (no fp column data)`);
        }
        return allFlows;
    }

    /**
     * Filter flows by selected IPs
     * Both initiator AND responder must be in the selected set
     * Loads CSV files on-demand for relevant IP pairs
     *
     * @param {string[]} selectedIPs - Array of selected IP addresses
     * @param {[number, number]|null} timeExtent - Optional time filter [start, end]
     * @returns {Promise<Array>} Filtered flows
     */
    async filterByIPs(selectedIPs, timeExtent = null) {
        if (!this.loaded || !this.pairsByKey) return [];
        if (!selectedIPs || selectedIPs.length === 0) return [];

        // Find relevant IP pairs
        const relevantPairs = this._getRelevantPairs(selectedIPs);
        console.log(`[FlowListLoader] Found ${relevantPairs.length} relevant IP pairs for ${selectedIPs.length} selected IPs`);

        if (relevantPairs.length === 0) return [];

        // Load flows for all relevant pairs (in parallel)
        const loadPromises = relevantPairs.map(pairKey => this._loadPairFlows(pairKey));
        const pairFlowArrays = await Promise.all(loadPromises);

        // Flatten and optionally filter by time
        let allFlows = pairFlowArrays.flat();

        if (timeExtent && timeExtent.length === 2) {
            const [start, end] = timeExtent;
            allFlows = allFlows.filter(flow =>
                flow.startTime >= start && flow.startTime <= end
            );
        }

        // Sort by start time
        allFlows.sort((a, b) => a.startTime - b.startTime);

        console.log(`[FlowListLoader] Returning ${allFlows.length} flows`);
        return allFlows;
    }

    /**
     * Get a flow by ID (searches loaded pairs)
     * @param {number|string} id - Flow ID
     * @returns {Object|null} Flow object or null
     */
    getFlowById(id) {
        if (!this.loaded) return null;

        const numId = Number(id);
        for (const pairInfo of this.pairsByKey.values()) {
            if (pairInfo.loaded && pairInfo.flows) {
                const flow = pairInfo.flows.find(f => f.id === numId);
                if (flow) return flow;
            }
        }
        return null;
    }

    /**
     * Check if the loader has flows with embedded packet data
     * @returns {boolean}
     */
    hasEmbeddedPackets() {
        if (!this.metadata || !this.metadata.columns) return false;
        // Check if 'fp' column is in the index metadata
        return this.metadata.columns.includes('fp');
    }

    /**
     * Get embedded packets for a flow, reconstructing full packet objects
     * @param {Object} flow - Flow object with _embeddedPackets
     * @returns {Array} Array of packet objects ready for visualization
     */
    getFlowPackets(flow) {
        if (!flow || !flow._hasEmbeddedPackets || !flow._embeddedPackets) {
            return [];
        }
        return flow._embeddedPackets;
    }

    /**
     * Build a full flow object compatible with enterFlowDetailMode
     * Reconstructs phases structure from embedded packets
     * @param {Object} flowSummary - Flow summary from flow list
     * @returns {Object} Full flow object with phases
     */
    buildFullFlow(flowSummary) {
        if (!flowSummary) return null;

        const packets = this.getFlowPackets(flowSummary);
        if (packets.length === 0) return null;

        // Classify packets into phases based on TCP flags
        const establishment = [];
        const dataTransfer = [];
        const closing = [];

        for (const pkt of packets) {
            const flags = pkt.flags;
            const phaseEntry = {
                packet: pkt,
                description: classifyFlagType(flags)
            };

            // SYN, SYN+ACK, or first ACK -> establishment
            // FIN, FIN+ACK, RST -> closing
            // Everything else -> data transfer
            if (flags & 0x02) { // SYN
                establishment.push(phaseEntry);
            } else if ((flags & 0x01) || (flags & 0x04)) { // FIN or RST
                closing.push(phaseEntry);
            } else {
                dataTransfer.push(phaseEntry);
            }
        }

        // If no establishment packets found, treat first few ACKs as establishment
        if (establishment.length === 0 && dataTransfer.length > 0) {
            // Move first ACK-only packet to establishment if it exists
            const firstAck = dataTransfer.findIndex(e => (e.packet.flags & 0x10) && !(e.packet.flags & 0x08));
            if (firstAck >= 0 && firstAck < 3) {
                establishment.push(...dataTransfer.splice(0, firstAck + 1));
            }
        }

        return {
            id: flowSummary.id,
            initiator: flowSummary.initiator,
            responder: flowSummary.responder,
            initiatorPort: flowSummary.initiatorPort,
            responderPort: flowSummary.responderPort,
            startTime: flowSummary.startTime,
            endTime: flowSummary.endTime,
            totalPackets: flowSummary.totalPackets,
            totalBytes: flowSummary.totalBytes,
            state: flowSummary.state,
            closeType: flowSummary.closeType,
            invalidReason: flowSummary.invalidReason,
            establishmentComplete: flowSummary.establishmentComplete,
            phases: {
                establishment: establishment,
                dataTransfer: dataTransfer,
                closing: closing
            },
            // Mark as embedded data source
            _fromEmbeddedPackets: true
        };
    }
}

/**
 * Classify TCP flags into a readable type
 * @param {number} flags - TCP flags value
 * @returns {string} Flag type description
 */
function classifyFlagType(flags) {
    if (flags === undefined || flags === null) return 'OTHER';
    const parts = [];
    if (flags & 0x02) parts.push('SYN');
    if (flags & 0x10) parts.push('ACK');
    if (flags & 0x01) parts.push('FIN');
    if (flags & 0x04) parts.push('RST');
    if (flags & 0x08) parts.push('PSH');
    return parts.length > 0 ? parts.join('+') : 'OTHER';
}

// Singleton instance
let flowListLoaderInstance = null;

/**
 * Get the singleton flow list loader instance
 * @returns {FlowListLoader}
 */
export function getFlowListLoader() {
    if (!flowListLoaderInstance) {
        flowListLoaderInstance = new FlowListLoader();
    }
    return flowListLoaderInstance;
}

/**
 * Try to load flow_list index and return whether it's available
 * @param {string} basePath - Base path to data directory
 * @returns {Promise<boolean>}
 */
export async function tryLoadFlowList(basePath) {
    const loader = getFlowListLoader();
    return await loader.load(basePath);
}
