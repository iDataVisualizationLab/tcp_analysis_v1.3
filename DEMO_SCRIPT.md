# Demo Video Script: TCP Network Analysis System

## Pre-Recording Setup

- Serve the project: `python -m http.server 8000`
- Browser: Chrome, full-screen (1920x1080 recommended)
- Have the folder dataset loaded: `packets_data/attack_flows_day1to5/`
- Close other tabs for a clean look

---

## ACT 1: Overview in TimeArcs (attack_timearcs.html)

### Scene 1.1 — Cold Start & Data Loading
**URL:** `http://localhost:8000/attack_timearcs.html`

1. Page loads with "Waiting for data..." status
2. The folder-based dataset auto-loads from `packets_data/attack_flows_day1to5/`
3. Progress bar fills as chunks stream in
4. **Narration:** *"This is the TimeArcs view. It shows network communication between IP addresses over a 5-day window. Each arc represents traffic between two IPs, colored by attack type."*

### Scene 1.2 — Orientation
1. Point out the **top axis** (timeline spanning ~5 days)
2. Point out the **IP labels** on the left (vertical node list)
3. Point out the **colored arcs** connecting IPs across time
4. Open the **Attack Types legend panel** (bottom-right floating panel) — show the color coding:
   - Purple = DDoS
   - Pink = Spambot / client compromise
   - Orange = C2-based
   - Teal = Post-phishing C2
   - Green = Other
5. **Narration:** *"Each arc connects a source and destination IP at the time an event occurred. The color tells us the attack category."*

### Scene 1.3 — Hovering Arcs
1. Hover over a **purple (DDoS) arc** — tooltip shows: source IP, destination IP, timestamp, event type
2. Hover over an **orange (C2) arc** — compare the tooltip info
3. Hover over an **IP label** — all connected arcs highlight
4. **Narration:** *"Hovering reveals details. Hovering an IP highlights all its connections, showing which IPs it communicated with."*

### Scene 1.4 — Compression & Bifocal Lens
1. Drag the **Compression slider** from 3x to 6x — arcs spread out in the focus region
2. Use **arrow keys** to move the bifocal focus region across the timeline
3. Show the **bifocal region indicator** updating (e.g., "Focus: 35% - 65%")
4. **Narration:** *"The bifocal lens lets us magnify a time region while keeping the full dataset visible. Arrow keys move the focus window."*

---

## ACT 2: Selecting Attacks for Deep Inspection

### Scene 2.1 — Brush Selection (DDoS Use Case)
> **USE CASE PLACEHOLDER: DDoS Attack Inspection**

1. Identify a cluster of **purple (DDoS) arcs** targeting a single internal IP (e.g., `172.28.4.7`)
2. **Click and drag** on empty space to draw a selection rectangle around the DDoS cluster
3. A numbered selection box appears with a blue dashed border
4. The **Brush Status** updates: "Selected: N arcs, M IPs"
5. **Narration:** *"I'll select this cluster of DDoS activity targeting 172.28.4.7. The brush captures all arcs and IPs within the rectangle."*

### Scene 2.2 — Opening TCP Analysis
1. Click the **"View Details"** button on the selection box
2. A new tab opens: `ip_bar_diagram.html?fromSelection=...`
3. The TCP Analysis view auto-loads with:
   - Pre-selected IPs from the TimeArcs selection
   - Zoomed to the selected time range
   - Data loading from the same dataset
4. **Narration:** *"Clicking 'View Details' opens the TCP Analysis view, pre-filtered to the exact IPs and time range I selected. No manual setup needed."*

---

## ACT 3: TCP Analysis — Packet-Level Inspection

### Scene 3.1 — Orientation in ip_bar_diagram
1. Point out the **main chart** — arcs/circles showing individual packets between IP pairs
2. Point out the **sidebar** — IP selection checkboxes, flag stats, IP stats
3. Point out the **overview chart** at the bottom (stacked bars showing flow health)
4. Point out the **zoom controls** (+/- buttons, time range indicator)
5. **Narration:** *"This view shows individual TCP packets. Each mark is a packet, positioned on an arc between source and destination. The overview at the bottom summarizes flow health across time."*

### Scene 3.2 — View Modes
1. Start in **Arc View (Circles)** — default mode
2. Switch to **Stacked Bars View** via the sidebar radio button
3. Show how the same data appears as stacked bars colored by TCP flag:
   - Red = SYN
   - Orange = SYN+ACK
   - Green = ACK
   - Blue = PSH+ACK
   - Purple = FIN
   - Dark grey = RST
4. Switch back to **Arc View**
5. **Narration:** *"Two view modes: Arc View shows individual packet timing; Stacked Bars shows volume distribution by TCP flag type."*

### Scene 3.3 — Zooming into the Attack Window
1. Use the **+ button** to zoom into the time range of interest
2. Or **drag the overview brush** to narrow the visible window
3. Show the **zoom indicator** updating with the current time range
4. Zoom in enough to see individual SYN/SYN+ACK/RST patterns
5. **Narration:** *"Zooming in reveals the packet-level structure. Watch how the resolution adapts — coarse bins at overview level, individual packets when zoomed."*

---

## ACT 4: Flow Analysis

### Scene 4.1 — Overview Chart & Flow Health
> **USE CASE PLACEHOLDER: DDoS — RST During Handshake**

1. Look at the **overview chart** stacked bars
2. Point out the color coding:
   - Green = Graceful close (normal)
   - Dark green = Abortive (RST-based close)
   - Purple = RST during handshake
   - Orange = Incomplete (no SYN+ACK)
   - Red = Invalid ACK
3. In a DDoS scenario, expect heavy **purple (rst_during_handshake)** bars
4. **Narration:** *"The overview chart shows flow health. In this DDoS attack, we see massive purple bars — RST during handshake — indicating the server is rejecting connection floods."*

### Scene 4.2 — Flow List Modal
1. **Click a bar** in the overview chart
2. The **Flow List Modal** opens showing all flows in that time bin
3. Point out columns: source port, destination port, close type, packet count
4. Use the **search box** to filter (e.g., type "rst" to show RST-related flows)
5. **Narration:** *"Clicking a bar opens the flow list. Each row is a TCP flow. I can search and filter to find specific patterns."*

### Scene 4.3 — Viewing Packets in a Flow
1. In the flow list, click a flow row to select it
2. Click **"View Packets"** button
3. The main chart zooms to show that flow's packets as arcs:
   - SYN (red) → RST (dark grey) = failed handshake
   - SYN (red) → SYN+ACK (orange) → ACK (green) → data → FIN = normal flow
4. **Narration:** *"View Packets shows the exact TCP state machine for this flow. In this DDoS flow, we see a SYN immediately followed by RST — the server rejecting the connection attempt."*

### Scene 4.4 — TCP Flow Phase Toggles
1. Toggle **Show Establishment Phase** off — SYN/SYN+ACK/ACK arcs disappear
2. Toggle it back on
3. Toggle **Show Closing Phase** off — FIN/RST arcs disappear
4. Toggle **Show Data Transfer Phase** off — PSH+ACK arcs disappear
5. **Narration:** *"Phase toggles let you isolate handshake, data transfer, or teardown. Useful for spotting anomalies in specific phases."*

---

## ACT 5: Ground Truth Validation

### Scene 5.1 — Enabling Ground Truth Overlay
1. In the sidebar, check **"Show Ground Truth Event Boxes"**
2. Colored rectangles appear on the main chart, overlaying time periods
3. Each box = a known attack event from the ground truth dataset
4. Hover a box — tooltip shows: event type, source IP, destination IP, time window
5. **Narration:** *"Ground truth overlays show known attack events from the labeled dataset. We can validate whether our visual analysis matches the documented attacks."*

### Scene 5.2 — Correlating Visual Patterns with Ground Truth
> **USE CASE PLACEHOLDER: Confirm DDoS Timing**

1. Show a cluster of RST-heavy traffic in the main chart
2. Show the ground truth box labeled "ddos" overlapping the same time range
3. **Narration:** *"The RST flood we identified visually aligns perfectly with the labeled DDoS event in the ground truth, confirming our analysis."*

---

## ACT 6: Repeat for Different Attack Types

### Scene 6.1 — C2 (Command & Control) Inspection
> **USE CASE PLACEHOLDER: C2 Heartbeat Detection**

1. Return to **TimeArcs** tab
2. Clear the previous brush selection (click "Clear")
3. Find **orange (C2-based) arcs** — look for periodic, evenly-spaced arcs between two IPs
4. Brush-select the C2 cluster → "View Details"
5. In TCP Analysis:
   - Expect **regular, small PSH+ACK packets** at fixed intervals (heartbeat pattern)
   - Flow close types mostly **graceful** (short-lived C2 check-in sessions)
   - Enable ground truth → confirm "c2" or "c2_heartbeat" label
6. **Narration:** *"C2 traffic looks different from DDoS. These are periodic, small connections — a compromised host checking in with its controller. The regularity is the giveaway."*

### Scene 6.2 — Port Scan / Reconnaissance
> **USE CASE PLACEHOLDER: Nmap Scan Detection**

1. Return to **TimeArcs** tab
2. Find arcs labeled with scan-related events (check legend for scan types)
3. Brush-select → "View Details"
4. In TCP Analysis:
   - Expect **many SYN packets to different destination ports** from a single source
   - Most flows: **incomplete_no_synack** (open ports) or **rst_during_handshake** (closed ports)
   - Overview chart dominated by orange (incomplete) and purple (RST) bars
5. **Narration:** *"A port scan generates hundreds of SYN packets to sequential ports. Closed ports respond with RST; open ports respond with SYN+ACK. The overview chart makes the pattern obvious."*

### Scene 6.3 — Spambot / Client Compromise
> **USE CASE PLACEHOLDER: Spambot Activity**

1. Return to **TimeArcs** tab
2. Find **pink (spambot) arcs** — often one internal IP connecting to many external IPs
3. Brush-select → "View Details"
4. In TCP Analysis:
   - Expect **many outbound connections** from a single internal IP
   - Flows are typically **short-lived, graceful closes** (SMTP connections)
   - High volume of distinct destination IPs
   - Check IP Statistics in sidebar — one IP has disproportionate outbound connections
5. **Narration:** *"The compromised host is sending spam — hundreds of short SMTP sessions to unique external IPs. The fan-out pattern in the arc view is characteristic of spambot activity."*

### Scene 6.4 — Data Exfiltration
> **USE CASE PLACEHOLDER: Post-Phishing Exfiltration**

1. Return to **TimeArcs** tab
2. Find **teal (post-phishing C2) arcs** — look for sustained connections
3. Brush-select → "View Details"
4. In TCP Analysis:
   - Expect **long-duration flows with large PSH+ACK packets** (data being sent out)
   - Asymmetric traffic: much more data in one direction
   - Flows are **graceful close** (attacker cleanly terminates after exfil)
   - Switch to **Stacked Bars** view to see the volume disparity
5. **Narration:** *"Exfiltration flows are long-lived with heavy data transfer in one direction. The stacked bar view makes the asymmetry clear — large blue PSH+ACK bars indicate bulk data movement."*

---

## ACT 7: Closing Summary

### Scene 7.1 — Side-by-Side Recap
1. Arrange both tabs side by side (or switch between them)
2. **Narration:** *"The two views are complementary. TimeArcs gives the macro view — who is attacking whom, when, and what type. TCP Analysis gives the micro view — individual packets, TCP state machines, and flow health. Together, they enable investigation from overview to packet-level detail."*

### Scene 7.2 — Key Takeaways (Voiceover)
- *"TimeArcs for pattern recognition and attack clustering"*
- *"Brush selection for seamless drill-down"*
- *"TCP Analysis for packet-level forensics"*
- *"Ground truth validation for confirmed findings"*
- *"Multi-resolution loading for performance at scale"*

---

## Timing Outline

| Act | Content | Suggested Duration |
|-----|---------|--------------------|
| 1 | TimeArcs orientation | 2-3 min |
| 2 | Selection & navigation | 1-2 min |
| 3 | TCP Analysis orientation | 2-3 min |
| 4 | Flow analysis deep-dive | 3-4 min |
| 5 | Ground truth validation | 1-2 min |
| 6 | Attack type use cases (pick 2-3) | 3-5 min each |
| 7 | Summary | 1 min |

**Total:** 15-25 min depending on how many use cases you include.

---

## Notes for Recording

- **Mouse movements:** Slow and deliberate. Pause on tooltips for readability.
- **Zooming:** Zoom in steps so viewers can track the transition.
- **Narration pace:** Pause after each visual change to let viewers absorb.
- **Fallback:** If the `fromSelection` auto-load fails (popup blocker), manually navigate to `ip_bar_diagram.html` and select the same IPs via the sidebar checkboxes.
- **IP addresses to feature:** `172.28.4.7` is a frequent DDoS target and appears in many flows — good anchor IP for the demo.

---

## Quick Reference: Color Coding

### Attack Types (TimeArcs)
| Color | Category |
|-------|----------|
| Purple | DDoS |
| Pink | Spambot / client compromise |
| Orange | C2-based |
| Teal | Post-phishing C2 |
| Green | Other |
| Dark grey | Normal |

### TCP Flags (TCP Analysis)
| Color | Flag |
|-------|------|
| Red | SYN |
| Orange | SYN+ACK |
| Green | ACK |
| Blue | PSH+ACK |
| Purple | FIN |
| Light purple | FIN+ACK |
| Dark grey | RST |
| Dark red | ACK+RST |

### Flow Close Types (Overview Chart)
| Color | Type | Meaning |
|-------|------|---------|
| Green | Graceful | Normal FIN teardown |
| Dark green | Abortive | RST-based close |
| Purple | RST during handshake | Reset before session established |
| Orange | Incomplete (no SYN+ACK) | Server never replied |
| Yellow | Incomplete (no ACK) | Client never completed handshake |
| Red | Invalid ACK | Malformed handshake completion |
| Grey | Ongoing | Still-active connection |
