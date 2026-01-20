// Enhanced packet filtering worker with memory optimization
// Protocol:
// - Main thread posts { type: 'init', packets }
//   -> worker responds { type: 'ready', version, packetCount }
// - Main thread posts { type: 'filterByKeys', keys: string[], showAllWhenEmpty: boolean }
//   -> worker responds { type: 'filtered', version, visible: Uint8Array }
// - Main thread posts { type: 'filterByIPs', ips: string[], showAllWhenEmpty: boolean }
//   -> worker responds { type: 'filtered', version, visible: Uint8Array }
// Notes:
// - The returned visibility mask length equals the packets array length.
//   The main thread will fall back to legacy filtering if this does not
//   match the current DOM dot count (e.g., when binning is active).

let version = 0;
let packets = [];
let connKeys = [];
let ipPairs = []; // Pre-computed IP pairs for faster filtering

function makeConnectionKey(src_ip, src_port, dst_ip, dst_port) {
  const sp = (src_port === undefined || src_port === null || isNaN(src_port)) ? 0 : Number(src_port);
  const dp = (dst_port === undefined || dst_port === null || isNaN(dst_port)) ? 0 : Number(dst_port);
  const a = `${src_ip}:${sp}-${dst_ip}:${dp}`;
  const b = `${dst_ip}:${dp}-${src_ip}:${sp}`;
  return a < b ? a : b;
}

function initPackets(list) {
  packets = Array.isArray(list) ? list : [];
  
  // Pre-compute connection keys and IP pairs for faster filtering
  connKeys = new Array(packets.length);
  ipPairs = new Array(packets.length);
  
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    connKeys[i] = makeConnectionKey(p.src_ip, p.src_port || 0, p.dst_ip, p.dst_port || 0);
    ipPairs[i] = [p.src_ip, p.dst_ip];
  }
}

function handleFilterByKeys(keys, showAllWhenEmpty) {
  try {
    const vis = new Uint8Array(packets.length);
    if (showAllWhenEmpty || !keys || keys.length === 0) {
      vis.fill(1);
    } else {
      const keySet = new Set(keys);
      for (let i = 0; i < connKeys.length; i++) {
        // Mark packet visible if its connection is selected
        vis[i] = keySet.has(connKeys[i]) ? 1 : 0;
      }
    }
    version += 1;
    // Transfer the underlying buffer for performance
    postMessage({ type: 'filtered', version, visible: vis }, [vis.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
}

function handleFilterByIPs(ips, showAllWhenEmpty) {
  try {
    const vis = new Uint8Array(packets.length);
    if (showAllWhenEmpty || !ips || ips.length === 0) {
      vis.fill(1);
    } else {
      const ipSet = new Set(ips);
      for (let i = 0; i < ipPairs.length; i++) {
        const [src_ip, dst_ip] = ipPairs[i];
        // Show if EITHER endpoint is in the selection (more inclusive)
        vis[i] = (ipSet.has(src_ip) || ipSet.has(dst_ip)) ? 1 : 0;
      }
    }
    version += 1;
    // Transfer the underlying buffer for performance
    postMessage({ type: 'filtered', version, visible: vis }, [vis.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
}

self.onmessage = function (e) {
  const msg = e && e.data;
  if (!msg || typeof msg.type !== 'string') {
    postMessage({ type: 'error', message: 'Invalid message' });
    return;
  }
  switch (msg.type) {
    case 'init': {
      try {
        initPackets(msg.packets);
        version += 1;
        postMessage({ type: 'ready', version, packetCount: packets.length });
      } catch (err) {
        postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
      }
      break;
    }
    case 'filterByKeys': {
      handleFilterByKeys(msg.keys || [], !!msg.showAllWhenEmpty);
      break;
    }
    case 'filterByIPs': {
      handleFilterByIPs(msg.ips || [], !!msg.showAllWhenEmpty);
      break;
    }
    default:
      postMessage({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
};

self.onerror = function (err) {
  try {
    postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  } catch (_) { /* ignore */ }
};
