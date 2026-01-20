// src/config/constants.js
// Extracted from attack_timearcs.js

export const MARGIN = { top: 40, right: 20, bottom: 30, left: 110 };
export const DEFAULT_WIDTH = 1200;
export const DEFAULT_HEIGHT = 600;
export const INNER_HEIGHT = 780;

export const PROTOCOL_COLORS = new Map([
  ['TCP', '#1f77b4'],
  ['UDP', '#2ca02c'],
  ['ICMP', '#ff7f0e'],
  ['GRE', '#9467bd'],
  ['ARP', '#8c564b'],
  ['DNS', '#17becf'],
]);

export const DEFAULT_COLOR = '#6c757d';
export const NEUTRAL_GREY = '#9e9e9e';

export const LENS_DEFAULTS = {
  magnification: 5,
  bandRadius: 0.045,
};

export const FISHEYE_DEFAULTS = {
  distortion: 5,
  effectRadius: 0.5,
};

// === Bar Diagram Specific Constants ===

// Debug flag
export const DEBUG = false;

// Radius scaling
export const RADIUS_MIN = 3;
export const RADIUS_MAX = 15;

// Row layout
export const ROW_GAP = 30;
export const TOP_PAD = 30;

// TCP States (matching tcp_analysis.py)
export const TCP_STATES = {
    S_NEW: 0,
    S_INIT: 1,
    S_SYN_RCVD: 2,
    S_EST: 3,
    S_FIN_1: 4,
    S_FIN_2: 5,
    S_CLOSED: 6,
    S_ABORTED: 7
};

// Handshake detection tunables
export const HANDSHAKE_TIMEOUT_MS = 3000;
export const REORDER_WINDOW_PKTS = 6;
export const REORDER_WINDOW_MS = 500;

// Default TCP flag colors
export const DEFAULT_FLAG_COLORS = {
    'SYN': '#e74c3c',
    'SYN+ACK': '#f39c12',
    'ACK': '#27ae60',
    'FIN': '#8e44ad',
    'FIN+ACK': '#9b59b6',
    'RST': '#34495e',
    'PSH+ACK': '#3498db',
    'ACK+RST': '#c0392b',
    'OTHER': '#bdc3c7'
};

// Flag curvature for arc paths (pixels of horizontal offset)
export const FLAG_CURVATURE = {
    'SYN': 12,
    'SYN+ACK': 18,
    'ACK': 24,
    'PSH+ACK': 14,
    'FIN': 18,
    'FIN+ACK': 20,
    'ACK+RST': 28,
    'RST': 30,
    'OTHER': 0
};

// Protocol number to name map
export const PROTOCOL_MAP = {
    1: 'ICMP',
    2: 'IGMP',
    6: 'TCP',
    17: 'UDP',
    41: 'IPv6',
    47: 'GRE',
    50: 'ESP',
    51: 'AH',
    58: 'ICMPv6',
    89: 'OSPF',
    132: 'SCTP'
};

// Default flow colors
export const DEFAULT_FLOW_COLORS = {
    closing: {
        graceful: '#8e44ad',
        abortive: '#c0392b'
    },
    ongoing: {
        open: '#6c757d',
        incomplete: '#adb5bd'
    },
    invalid: {}
};

// Default event colors for ground truth
export const DEFAULT_EVENT_COLORS = {
    'normal': '#4B4B4B',
    'client compromise': '#D41159',
    'malware ddos': '#2A9D4F',
    'scan /usr/bin/nmap': '#C9A200',
    'ddos': '#264D99'
};
