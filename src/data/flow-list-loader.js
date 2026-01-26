// src/data/flow-list-loader.js
// Loads flow_list CSV files for flow list popup with embedded packet data

// Close type decoding - matches CLOSE_TYPE_ENCODING in generate_flow_data.py
const CLOSE_TYPE_DECODING = [
    '',                      // 0
    'graceful',              // 1
    'abortive',              // 2
    'ongoing',               // 3
    'rst_during_handshake',  // 4
    'invalid_ack',           // 5
    'invalid_synack',        // 6
    'incomplete_no_synack',  // 7
    'incomplete_no_ack',     // 8
    'unknown_invalid',       // 9
];

/**
 * Parse the packets column into an array of packet objects
 * Format: delta_ts:flags:dir,...
 * dir: 1=ip1->ip2, 0=ip2->ip1 (based on alphabetical IP order from filename)
 * First packet's dir determines initiator: dir=1 means ip1 initiated, dir=0 means ip2 initiated
 * Note: length, seq, ack not included for now
 *
 * @param {string} packetsString - The packets column value
 * @param {number} flowStartTime - The flow's start time in microseconds
 * @param {string} ip1 - First IP (alphabetically) from filename
 * @param {string} ip2 - Second IP (alphabetically) from filename
 * @param {number} initiatorPort - Initiator's port
 * @param {number} responderPort - Responder's port
 * @returns {Object} { packets: Array, initiator: string, responder: string }
 */
function parseFlowPackets(packetsString, flowStartTime, ip1, ip2, initiatorPort, responderPort) {
    if (!packetsString || typeof packetsString !== 'string' || packetsString.trim() === '') {
        return { packets: [], initiator: ip1, responder: ip2 };
    }

    const parts = packetsString.split(',');

    // Determine initiator from first packet's dir
    // First packet (SYN) is from initiator, so its dir tells us which IP initiated
    let initiator = ip1;
    let responder = ip2;
    if (parts.length > 0) {
        const firstFields = parts[0].trim().split(':');
        const firstDir = firstFields[2];
        if (firstDir === '0') {
            // First packet is from ip2, so ip2 is initiator
            initiator = ip2;
            responder = ip1;
        }
    }

    const packets = [];
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;

        const fields = part.split(':');
        const delta = parseInt(fields[0], 10) || 0;
        const flags = parseInt(fields[1], 10) || 0;
        const isFromIp1 = fields[2] === '1';

        // Determine if packet is from initiator
        const isFromInitiator = (initiator === ip1) ? isFromIp1 : !isFromIp1;

        // Set src/dst based on direction
        const src_ip = isFromIp1 ? ip1 : ip2;
        const dst_ip = isFromIp1 ? ip2 : ip1;
        const src_port = isFromInitiator ? initiatorPort : responderPort;
        const dst_port = isFromInitiator ? responderPort : initiatorPort;

        packets.push({
            timestamp: flowStartTime + delta,
            flags: flags,
            src_ip: src_ip,
            dst_ip: dst_ip,
            src_port: src_port,
            dst_port: dst_port,
            // length, seq_num, ack_num not included for now
            length: 0,
            seq_num: null,
            ack_num: null,
            _index: i,
            _fromInitiator: isFromInitiator
        });
    }

    return { packets, initiator, responder };
}

/**
 * Parse a CSV row into a flow object
 * CSV columns: start_time,src_port,dst_port,close_type,packets
 * Note: close_type contains close type (graceful/abortive/ongoing) or invalid reason directly
 * Note: packet_count, duration, and initiator derived from packets column
 * @param {string[]} row - CSV row fields
 * @param {number} index - Row index for ID
 * @param {string} ip1 - First IP (alphabetically) from filename
 * @param {string} ip2 - Second IP (alphabetically) from filename
 */
function parseFlowRow(row, index, ip1, ip2) {
    const [start_time, src_port, dst_port, close_type, packets] = row;
    const startTime = parseInt(start_time, 10);
    const initiatorPort = parseInt(src_port, 10) || 0;
    const responderPort = parseInt(dst_port, 10) || 0;

    // Parse embedded packets - also determines initiator/responder from first packet's dir
    const parseResult = packets
        ? parseFlowPackets(packets, startTime, ip1, ip2, initiatorPort, responderPort)
        : { packets: [], initiator: ip1, responder: ip2 };

    const embeddedPackets = parseResult.packets;
    const initiator = parseResult.initiator;
    const responder = parseResult.responder;

    // Derive endTime from last packet's timestamp
    const endTime = embeddedPackets.length > 0
        ? embeddedPackets[embeddedPackets.length - 1].timestamp
        : startTime;

    // Calculate total bytes from embedded packets if available
    const totalBytes = embeddedPackets.length > 0
        ? embeddedPackets.reduce((sum, pkt) => sum + pkt.length, 0)
        : 0;

    // Decode close_type from integer
    const closeTypeCode = parseInt(close_type, 10) || 0;
    const closeTypeStr = CLOSE_TYPE_DECODING[closeTypeCode] || '';

    // Determine if invalid (codes 4-9 are invalid reasons)
    const isInvalid = closeTypeCode >= 4;
    const closeTypeValue = isInvalid ? 'invalid' : closeTypeStr;
    const invalidReason = isInvalid ? closeTypeStr : '';

    return {
        id: index,
        initiator: initiator,
        responder: responder,
        startTime: startTime,
        endTime: endTime,
        totalPackets: embeddedPackets.length,  // Derived from packets column
        initiatorPort: initiatorPort,
        responderPort: responderPort,
        closeType: closeTypeValue,
        invalidReason: invalidReason,
        // Derived fields for compatibility
        totalBytes: totalBytes,
        state: isInvalid ? 'invalid' : (closeTypeStr ? 'closed' : 'unknown'),
        establishmentComplete: closeTypeValue === 'graceful' || closeTypeValue === 'abortive',
        // Embedded packet data from packets column
        _embeddedPackets: embeddedPackets,
        _hasEmbeddedPackets: embeddedPackets.length > 0
    };
}

/**
 * Parse a CSV line handling quoted fields (for packets column with commas)
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
 * Handles the packets column which contains comma-separated packet data (quoted)
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
            const hasPacketsColumn = this.index.columns && this.index.columns.includes('packets');
            const uniquePairs = this.pairsByKey.size;
            const splitPairs = [...this.pairsByKey.values()].filter(p => p.files.length > 1).length;

            console.log(`[FlowListLoader] Index loaded from ${url}`);
            console.log(`[FlowListLoader]   ${uniquePairs} IP pairs, ${this.index.total_flows.toLocaleString()} total flows`);
            if (splitPairs > 0) {
                console.log(`[FlowListLoader]   ${splitPairs} pairs split into multiple files`);
            }
            if (hasPacketsColumn) {
                console.log(`[FlowListLoader] ✓ packets column detected - embedded packet data available for visualization`);
            } else {
                console.log(`[FlowListLoader] No packets column - packet visualization will require chunk files`);
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
            console.log(`[FlowListLoader] Loaded ${allFlows.length} flows from ${fileDesc} (no packets column data)`);
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
        return this.metadata.columns.includes('packets');
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
