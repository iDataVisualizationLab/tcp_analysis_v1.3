# Debug Logging Reference

This document catalogs the debug console.log statements that were added during development to troubleshoot TimeArcs flow loading issues. These logs have been removed from production code but are documented here for future reference.

## Issue Context

**Problem**: When loading big TimeArcs selections, the flow list popup showed incorrect flows (100k+ instead of filtered subset) and "View Packets" button failed with "Unable to load flow detail" error.

**Root Causes Identified**:
1. HTTP-based `loadChunksForTimeRange` wasn't filtering by selected IPs
2. `loadFlowDetailViaFetch` was using time-only chunk lookup, causing wrong chunks to be loaded
3. Chunk organization is by flow ID (sequential, 300 per chunk), not by time
4. Multiple chunks can overlap in time but contain different flows

## Debug Logs Removed

### tcp-analysis.js

#### Lines 531-568: Overview Chart Wrapper Function
**Purpose**: Track IP filtering being passed to flow loaders

```javascript
console.log('[Overview] loadChunksForTimeRange called:', startTime, endTime);
console.log('[Overview] flowDataState:', state ? Object.keys(state) : 'null');
console.log('[Overview] ========================================');
console.log('[Overview] Filtering flows by selected IPs:', selectedIPs.length, 'IPs');
console.log('[Overview] Selected IPs:', selectedIPs);
console.log('[Overview] ========================================');
console.log('[Overview] Calling state.loadChunksForTimeRange with IP filter...');
console.log('[Overview] Got result:', result ? result.length : 'null', 'flows (filtered by IPs)');
console.log('[Overview] Calling state.loadFlowsForTimeRange (multires)...');
console.log('[Overview] Got result:', result ? result.length : 'null', 'flows');
console.log('[Overview] Filtered multires flows from', result.length, 'to', filtered.length);
console.log('[Overview] No flow loader function available in flowDataState');
```

**What it tracked**:
- Which flow loader function was being called (chunked vs multires)
- How many IPs were selected for filtering
- Flow counts before/after filtering
- Whether IP filtering was working correctly

#### Lines 2916-3014: loadFlowDetailViaFetch Chunk Lookup
**Purpose**: Track flow ID-based chunk lookup and fallback strategies

```javascript
console.log(`[FlowDetail-Fetch] Found chunk by ID: ${targetChunk.file} (index ${expectedChunkIndex})`);
console.log(`[FlowDetail-Fetch] Flow ID-based lookup failed, trying time + IP lookup...`);
console.log(`[FlowDetail-Fetch] Found matching chunk by time+IPs: ${chunk.file} (${chunk.start} - ${chunk.end})`);
console.log(`[FlowDetail-Fetch] Chunk contains both IPs: ${initiator}, ${responder}`);
console.log(`[FlowDetail-Fetch] Chunk ${chunk.file} has matching time but missing IPs (has ${initiator}: ${hasInitiator}, has ${responder}: ${hasResponder})`);
console.warn(`[FlowDetail-Fetch] ❌ No chunk found for flow ${flowId} with startTime ${flowStartTime}`);
console.warn(`[FlowDetail-Fetch] First chunk time range: ${chunksMeta[0]?.start} - ${chunksMeta[0]?.end}`);
console.warn(`[FlowDetail-Fetch] Last chunk time range: ${chunksMeta[chunksMeta.length-1]?.start} - ${chunksMeta[chunksMeta.length-1]?.end}`);
console.log(`[FlowDetail-Fetch] Found flow ${flowId} in ${chunk.file}`);
console.log(`[FlowDetail-Fetch] Loading chunk ${targetChunk.file}`);
console.log(`[FlowDetail-Fetch] Chunk contains ${flows.length} flows`);
console.warn(`[FlowDetail-Fetch] Flow ${flowId} not found by ID, trying by connection tuple...`);
console.log(`[FlowDetail-Fetch] ✅ Found flow by connection tuple: ${flow.id}`);
console.error(`[FlowDetail-Fetch] ❌ Flow not found by ID or tuple`);
console.error(`[FlowDetail-Fetch] Looking for: ${initiator}:${initiatorPort} ↔ ${responder}:${responderPort} @ ${startTime}`);
console.error(`[FlowDetail-Fetch] Sample flow IDs from chunk:`, flows.slice(0, 5).map(f => f.id));
console.error(`[FlowDetail-Fetch] Sample connections:`, flows.slice(0, 3).map(f => ...));
```

**What it tracked**:
- Whether flow ID-based chunk lookup succeeded (O(1) lookup)
- Fallback to time+IP lookup when ID lookup failed
- Which chunks were being searched and why
- Why chunks were rejected (missing IPs, wrong time range)
- Connection tuple matching when flow ID didn't match
- Sample data from chunks for debugging mismatches

#### Lines 5245-5303: HTTP-based loadChunksForTimeRange
**Purpose**: Track IP filtering in fetch-based flow loading

```javascript
console.log('[HTTP-FlowLoader] ========================================');
console.log('[HTTP-FlowLoader] loadChunksForTimeRange called:', { startTime, endTime, selectedIPsCount: selectedIPs ? selectedIPs.length : 0 });
console.log('[HTTP-FlowLoader] selectedIPs:', selectedIPs);
console.log('[HTTP-FlowLoader] selectedIPSet:', selectedIPSet ? selectedIPSet.size : 'null', 'IPs');
console.log('[HTTP-FlowLoader] Loading', relevantChunks.length, 'chunks for time range');
console.log(`[HTTP-FlowLoader] ${chunk.file}: ${chunkFlows.length} total, ${timeFiltered} time-filtered, ${ipFiltered} IP-filtered, ${passed} passed`);
console.warn(`[HTTP-FlowLoader] Failed to load chunk ${chunk.file}:`, err);
console.log('[HTTP-FlowLoader] ========================================');
console.log('[HTTP-FlowLoader] TOTALS:', { totalFlowsLoaded, totalTimeFiltered, totalIPFiltered, totalPassed });
console.log('[HTTP-FlowLoader] Returning', allFlows.length, 'flows');
console.log('[HTTP-FlowLoader] ========================================');
```

**What it tracked**:
- How many IPs were being used for filtering
- How many chunks overlapped the time range
- Per-chunk breakdown: total flows, time-filtered, IP-filtered, passed
- Overall totals across all chunks
- Which chunks failed to load

### folder_integration.js

#### Lines 532-626: File System API loadChunksForTimeRange
**Purpose**: Track IP filtering in File System API-based flow loading

```javascript
console.log('[FlowLoader] ========================================');
console.log('[FlowLoader] loadChunksForTimeRange called with:', { startTime, endTime, selectedIPsCount: selectedIPs ? selectedIPs.length : 0 });
console.log('[FlowLoader] selectedIPs:', selectedIPs);
console.log('[FlowLoader] ========================================');
console.warn('[FlowLoader] No chunked flow state available');
console.log('[FlowLoader] selectedIPSet created:', selectedIPSet ? selectedIPSet.size : 'null', 'IPs');
console.log(`[FlowLoader] No chunks found for time range ${startTime} - ${endTime}`);
console.log(`[FlowLoader] Loading ${relevantChunks.length} chunks for time range${ipFilterMsg}`);
console.log(`[FlowLoader] Cached ${chunk.file}: ${cachedFlows.length} total flows, ${timeFiltered} time-filtered, ${ipFiltered} IP-filtered, ${passed} passed`);
console.log(`[FlowLoader] Loaded ${chunk.file}: ${flows.length} total flows, ${timeFiltered} time-filtered, ${ipFiltered} IP-filtered, ${passed} passed`);
console.log(`[FlowLoader] Sample passed flows:`, filtered.slice(0, 3).map(f => `${f.initiator}↔${f.responder}`));
console.error(`[FlowLoader] Failed to load ${chunk.file}:`, err);
console.log(`[FlowLoader] Total flows for time range: ${allFlows.length}${ipFilterMsg}`);
```

**What it tracked**:
- Function parameters (time range, IP count)
- Cache hits vs disk loads
- Per-chunk filtering breakdown (time vs IP filtering)
- Sample flows that passed filtering
- Total flows returned after all filtering

## Key Metrics Tracked

### Flow Filtering Funnel
1. **totalFlowsLoaded**: Raw flows loaded from chunk files
2. **totalTimeFiltered**: Flows excluded by time range (f.startTime > endTime || f.endTime < startTime)
3. **totalIPFiltered**: Flows excluded by IP filter (initiator OR responder not in selected IPs)
4. **totalPassed**: Flows matching both time range AND IP filter

### Chunk Lookup Strategies
1. **ID-based (O(1))**: flowId "flow_1678997" → chunk index 5596 (1678997 / 300)
2. **Time+IP (O(n))**: Linear search for chunks with matching time range AND containing both IPs
3. **Emergency scan**: Scan first 10 chunks looking for flow ID (last resort)

### Connection Tuple Matching
When flow ID doesn't match between overview and chunk:
- Match by (initiator, responder, initiatorPort, responderPort, startTime)
- Allow 1ms timestamp tolerance

## Performance Insights

### Before Optimization
- Linear search through 18,277 chunks to find flow
- Often found wrong chunk (time overlap but different IPs)
- Failed when flow IDs didn't match between list and chunk

### After Optimization
- Direct O(1) chunk calculation from flow ID
- Fallback to time+IP when ID unavailable
- Connection tuple matching for ID mismatches
- Typical lookup time: <10ms vs 100ms+

## When to Re-enable Debug Logs

If similar issues arise in the future, re-enable these logs by:

1. Adding `[Component]` prefixed console.log statements
2. Using separator lines (===) for visual grouping
3. Logging filter funnel metrics (total → time-filtered → IP-filtered → passed)
4. Including sample data (first 3-5 items) when counts are unexpected
5. Using console.error for genuine errors, console.warn for fallback paths

## Related Files

- `tcp-analysis.js` - Main visualization, HTTP-based loading
- `folder_integration.js` - File System API-based loading
- `attack-network.js` - Generates selection data for detail view
- `overview_chart.js` - Consumes filtered flows for stacked chart

## Data Format Notes

- Chunks: 300 flows each, organized by sequential flow ID
- Flow ID format: "flow_XXXXXX" (e.g., "flow_1678997")
- Chunk file format: "chunk_05596.json" (5-digit zero-padded)
- Multiple chunks can overlap in time
- Flow filtering requires BOTH initiator AND responder in selected IP set
