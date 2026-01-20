// src/workers/packetWorkerManager.js
// Web worker management for packet filtering

import { LOG } from '../utils/formatters.js';

/**
 * Create packet worker manager.
 * @param {Object} options - {workerPath, onVisibilityApplied, onError}
 * @returns {Object} Worker manager API
 */
export function createPacketWorkerManager(options = {}) {
    const {
        workerPath = 'packet_worker.js',
        onVisibilityApplied,
        onError
    } = options;

    let worker = null;
    let ready = false;
    let lastVersion = 0;
    let pendingRequest = null;
    let visibilityMask = null;

    function init() {
        if (worker) return;

        try {
            worker = new Worker(workerPath);

            worker.onmessage = (e) => {
                const msg = e.data;
                switch (msg.type) {
                    case 'ready':
                        ready = true;
                        lastVersion = msg.version || 0;
                        LOG('[Worker] Ready. packets=', msg.packetCount);
                        if (pendingRequest) {
                            worker.postMessage(pendingRequest);
                            pendingRequest = null;
                        }
                        break;
                    case 'filtered':
                        if ((msg.version || 0) < lastVersion) return; // stale
                        lastVersion = msg.version || lastVersion;
                        visibilityMask = msg.visible;
                        if (onVisibilityApplied) {
                            onVisibilityApplied(visibilityMask);
                        }
                        break;
                    case 'error':
                        console.error('[Worker] error:', msg.message);
                        if (onError) onError(msg.message);
                        break;
                }
            };

            worker.onerror = (err) => {
                console.error('[Worker] onerror', err);
                if (onError) onError(err);
            };
        } catch (err) {
            console.error('Failed creating worker', err);
            if (onError) onError(err);
        }
    }

    function initPackets(packets) {
        if (!worker) init();
        ready = false;
        // Assign stable index for each packet
        packets.forEach((p, i) => p._packetIndex = i);
        worker.postMessage({ type: 'init', packets });
    }

    function filterByKeys(keys, showAllWhenEmpty = true) {
        const msg = { type: 'filterByKeys', keys, showAllWhenEmpty };
        if (!ready) {
            pendingRequest = msg;
        } else {
            try {
                worker.postMessage(msg);
            } catch (e) {
                console.error('postMessage failed', e);
            }
        }
    }

    function terminate() {
        if (worker) {
            worker.terminate();
            worker = null;
            ready = false;
        }
    }

    function isReady() {
        return ready;
    }

    function getVisibilityMask() {
        return visibilityMask;
    }

    return {
        init,
        initPackets,
        filterByKeys,
        terminate,
        isReady,
        getVisibilityMask
    };
}

/**
 * Apply visibility mask to DOM elements in batches.
 * @param {Uint8Array} mask - Visibility mask (1 = visible, 0 = hidden)
 * @param {Array} nodes - DOM nodes
 * @param {Object} options - {batchSize, onComplete}
 */
export function applyVisibilityToDots(mask, nodes, options = {}) {
    const { batchSize = 4000, onComplete } = options;

    if (!mask || !nodes) {
        console.warn('Missing mask or nodes for visibility application');
        if (onComplete) onComplete();
        return;
    }

    if (nodes.length !== mask.length) {
        console.warn(`Mask length mismatch: mask=${mask.length}, nodes=${nodes.length}. Skipping visibility update.`);
        if (onComplete) onComplete();
        return;
    }

    function batch(start) {
        const end = Math.min(nodes.length, start + batchSize);
        for (let i = start; i < end; i++) {
            nodes[i].style.display = mask[i] === 1 ? '' : 'none';
        }
        if (end < nodes.length) {
            requestAnimationFrame(() => batch(end));
        } else if (onComplete) {
            onComplete();
        }
    }

    requestAnimationFrame(() => batch(0));
}