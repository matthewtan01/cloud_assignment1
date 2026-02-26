$(document).ready(docMain);

var conf = new Object();
conf["depth"] = 3; // Fixed for 3-tier Jupiter/Clos model usually, but we keep the var.
conf["width"] = 4; // k-ary fat tree. - Default 4 for visualization
conf["ocs"] = 4; // Number of Optical Circuit Switch links

var topology = {}; // To store the graph
var stats = {};

function docMain() {
  formInit();
  // Delay slightly to ensure form ensures k=4 on load if needed or just initial draw
  rebuildAndRedraw();
  $(document).keypress(kpress);
}

// Simple graph node
class Node {
  constructor(id, type, podIndex) {
    this.id = id;
    this.type = type; // 'host', 'edge', 'agg', 'core'
    this.podIndex = podIndex; // -1 for core
    this.links = []; // adjacency list
  }
}

function rebuildAndRedraw() {
  buildTopology(conf["width"]);
  analyzeTopology();
  updateStatDisplay();
  drawTopology();
}

function buildTopology(k) {
  topology = {
    hosts: [],
    edges: [],
    aggs: [],
    cores: [],
    nodes: {}, // map id -> Node
    links: [], // list of link objects for d3
  };

  var numPods = k;
  var switchesPerPodLayer = k / 2;
  var hostsPerEdge = k / 2;
  var numCores = (k / 2) * (k / 2);

  // Create Core Switches
  for (var i = 0; i < numCores; i++) {
    var id = "core_" + i;
    var node = new Node(id, "core", -1);
    topology.cores.push(node);
    topology.nodes[id] = node;
  }

  // Create Pods
  for (var p = 0; p < numPods; p++) {
    // Create Aggregation Switches
    var podAggs = [];
    for (var a = 0; a < switchesPerPodLayer; a++) {
      var id = "agg_" + p + "_" + a;
      var node = new Node(id, "agg", p);
      topology.aggs.push(node);
      podAggs.push(node);
      topology.nodes[id] = node;
    }

    // Create Edge Switches
    var podEdges = [];
    for (var e = 0; e < switchesPerPodLayer; e++) {
      var id = "edge_" + p + "_" + e;
      var node = new Node(id, "edge", p);
      topology.edges.push(node);
      podEdges.push(node);
      topology.nodes[id] = node;

      // Create Hosts
      for (var h = 0; h < hostsPerEdge; h++) {
        var hid = "host_" + p + "_" + e + "_" + h;
        var hnode = new Node(hid, "host", p);
        topology.hosts.push(hnode);
        topology.nodes[hid] = hnode;

        // Link Host <-> Edge
        addLink(hnode, node);
      }
    }

    // Link Edge <-> Agg (Full Mesh within Pod)
    for (var e = 0; e < podEdges.length; e++) {
      for (var a = 0; a < podAggs.length; a++) {
        addLink(podEdges[e], podAggs[a]);
      }
    }

    // Link Agg <-> Core
    // Standard Fat Tree connection:
    // agg switch 'a' in pod 'p' connects to cores index (a * (k/2) + ... )
    // Actually, Agg 'a' (0 to k/2-1) connects to Cores: a * (k/2) to (a+1)*(k/2) - 1
    // This ensures the stride distributes connections correctly.
    for (var a = 0; a < podAggs.length; a++) {
      var startCoreIndex = a * (k / 2);
      for (var cOffset = 0; cOffset < k / 2; cOffset++) {
        var coreIndex = startCoreIndex + cOffset;
        var coreNode = topology.cores[coreIndex];
        addLink(podAggs[a], coreNode);
      }
    }
  }

  // --- Add OCS Links (Agg <-> Agg) ---
  // Create direct links between random aggregation switches in *different* pods.
  // This simulates the reconfigurable optical layer bypassing the Core.
  var numOCS = conf["ocs"];
  if (numOCS > 0 && topology.aggs.length > 1) {
    for (var i = 0; i < numOCS; i++) {
      // Pick two random Agg switches from different pods
      var agg1 =
        topology.aggs[Math.floor(Math.random() * topology.aggs.length)];
      var agg2 =
        topology.aggs[Math.floor(Math.random() * topology.aggs.length)];

      // Retry if same pod or same switch (simple retry logic)
      var attempts = 0;
      while (
        (agg1.podIndex === agg2.podIndex || agg1.id === agg2.id) &&
        attempts < 10
      ) {
        agg2 = topology.aggs[Math.floor(Math.random() * topology.aggs.length)];
        attempts++;
      }

      if (agg1.podIndex !== agg2.podIndex) {
        addLink(agg1, agg2, "ocs");
      }
    }
  }
}

function addLink(node1, node2, type) {
  node1.links.push(node2.id);
  node2.links.push(node1.id);
  topology.links.push({ source: node1, target: node2, type: type || "cable" });
}

function analyzeTopology() {
  var k = conf["width"];

  // 1. Path Uniqueness to Core Layer (from an Edge Switch)
  // How many unique paths exist from an Edge switch to the Core Layer?
  // Path = Edge -> Agg -> Core.
  // We count distinct Core nodes reachable via disjoint paths.

  if (topology.edges.length > 0) {
    var sampleEdge = topology.edges[0];
    // Each connected Agg represents a disjoint path to the Core layer for upstream traffic
    // So we count how many Aggs it connects to, and ensure each Agg has a path to Core.

    var validPaths = 0;
    sampleEdge.links.forEach((aggId) => {
      var agg = topology.nodes[aggId];
      if (agg.type === "agg") {
        // Check if this agg connects to any core
        var hasCoreLink = agg.links.some(
          (nid) => topology.nodes[nid].type === "core",
        );
        if (hasCoreLink) validPaths++;
      }
    });

    stats.uniqPathsToCore = validPaths + " (via Aggs)";

    // Count total reachable Cores
    var reachableCores = new Set();
    sampleEdge.links.forEach((aggId) => {
      var agg = topology.nodes[aggId];
      if (agg.type === "agg") {
        agg.links.forEach((coreId) => {
          if (topology.nodes[coreId].type === "core") {
            reachableCores.add(coreId);
          }
        });
      }
    });
    stats.reachableCores = reachableCores.size;
  } else {
    stats.uniqPathsToCore = 0;
    stats.reachableCores = 0;
  }

  // 2. Intra-Pod Paths (Host to Host in same Pod)
  // Host -> Edge -> Agg -> Edge -> Host
  // Multi-pathing depends on Number of Agg switches
  stats.intraPodPaths = Math.floor(k / 2);

  // 3. Inter-Pod Paths (Host to Host in different Pod)
  // Host -> Edge -> Agg -> Core -> Agg -> Edge -> Host
  // Each flow can pick any Agg (k/2 choices).
  // Each Agg has (k/2) uplinks to Core.
  // Total paths = (k/2) * (k/2) = k^2 / 4
  // This assumes Core switches are non-blocking and we just count path options.
  stats.interPodPaths = Math.floor((k / 2) * (k / 2));

  // 4. Bisection Bandwidth
  // Ratio of bisection capacity vs host aggregate bandwidth.
  // Core Capacity = NumCores * k ports (but actually only k ports per switch used for downlink?)
  // No, Core switches have k ports, all connected to Pods.
  // k ports * (k/2)^2 switches = k^3/4 links.
  // Host Capacity = NumHosts * 1 link = (k^3/4) links.
  // Ratio = 1.0 (Full Bisection)
  var hostBW = Math.pow(k, 3) / 4;
  var coreBW = Math.pow(k / 2, 2) * k; // All ports face down to Pods in a 2-layer folded Clos view?
  // Wait, Core switches connect to k Pods. So k ports used.
  // Capacity matches.

  stats.bisectionBW = hostBW > 0 ? (coreBW / hostBW).toFixed(2) : 0;
  stats.totalHosts = hostBW;
  stats.ocsLinks = topology.links.filter((l) => l.type === "ocs").length;
}

function updateStatDisplay() {
  d3.select("#nhost").text(stats.totalHosts);
  d3.select("#nswitch").text(
    topology.edges.length + topology.aggs.length + topology.cores.length,
  );
  d3.select("#ncable").text(topology.links.length);
  d3.select("#ntx").text(topology.links.length * 2); // 2 tx per cable
  // "Switch Tx's" = Total Tx - Host Tx. Host Tx = NumHosts (since each has 1 link)
  d3.select("#nswtx").text(topology.links.length * 2 - stats.totalHosts);

  d3.select("#path_core").text(
    stats.reachableCores + " Cores Reachable via " + stats.uniqPathsToCore,
  );
  d3.select("#path_intra").text(stats.intraPodPaths + " Paths (via Aggs)");
  d3.select("#path_inter").text(stats.interPodPaths + " Paths (via Cores)");
  d3.select("#bisection_bw").text(stats.bisectionBW + " (Normalized)");
  d3.select("#path_ocs").text(stats.ocsLinks + " Direct Inter-Pod Links");
}

// --- Visualization ---
// We need a custom layout for the 3 tiers + Hosts.
function drawTopology() {
  d3.select("svg.main").remove();

  var w = $(window).width() - 40;
  var h = 700;

  var svg = d3
    .select("body")
    .append("svg")
    .attr("width", w)
    .attr("height", h)
    .attr("class", "main")
    .append("g");

  // Layout parameters
  var coreY = 50;
  var aggY = 250;
  var edgeY = 450;
  var hostY = 600;

  var k = conf["width"];
  var numPods = k;

  // Calculate X positions
  // Spacing
  var totalWidth = w - 100;
  if (totalWidth < 0) totalWidth = 800; // Safety

  // 1. Layout Hosts/Edges/Aggs (grouped by Pod)
  var podWidth = totalWidth / numPods;

  topology.hosts.forEach((n) => {
    // Calculate global index or position
    var p = n.podIndex;
    // We need to know which edge it belongs to.
    // id is "host_p_e_h"
    var parts = n.id.split("_");
    var eIdx = parseInt(parts[2]);
    var hIdx = parseInt(parts[3]);

    var podX = p * podWidth + podWidth / 2;
    // Offset within pod
    // How many hosts in pod? (k/2)*(k/2) = k^2/4
    var hostsInPod = (k / 2) * (k / 2);
    var globalHostIdxInPod = eIdx * (k / 2) + hIdx;

    // Distribute evenly in pod width
    var offset =
      (globalHostIdxInPod - (hostsInPod - 1) / 2) *
      (podWidth / (hostsInPod + 1 || 1));

    n.x = podX + offset + 50; // +50 for margin
    n.y = hostY;
  });

  topology.edges.forEach((n) => {
    var p = n.podIndex;
    var parts = n.id.split("_");
    var eIdx = parseInt(parts[2]);

    var podX = p * podWidth + podWidth / 2;
    var edgesInPod = k / 2;
    var offset =
      (eIdx - (edgesInPod - 1) / 2) * (podWidth / (edgesInPod + 1 || 1));

    n.x = podX + offset + 50;
    n.y = edgeY;
  });

  topology.aggs.forEach((n) => {
    var p = n.podIndex;
    var parts = n.id.split("_");
    var aIdx = parseInt(parts[2]);

    var podX = p * podWidth + podWidth / 2;
    var aggsInPod = k / 2;
    var offset =
      (aIdx - (aggsInPod - 1) / 2) * (podWidth / (aggsInPod + 1 || 1));

    n.x = podX + offset + 50;
    n.y = aggY;
  });

  // 2. Layout Cores
  // Distributed evenly across top
  var numCores = topology.cores.length;
  topology.cores.forEach((n, i) => {
    var x = (i + 0.5) * (totalWidth / numCores) + 50;
    n.x = x;
    n.y = coreY;
  });

  // Draw Links
  svg
    .selectAll(".link")
    .data(topology.links)
    .enter()
    .append("path") // Use path instead of line for curves
    .attr("class", (d) => d.type) // cable or ocs
    .attr("d", (d) => {
      if (d.type === "ocs") {
        // Arc for OCS links to make them visible jumping over pods
        // AggY is ~250. Let's arc upwards towards Core layer but below it?
        // Or downwards if they are far apart.
        // A simple quadratic bezier curve.
        var dx = d.target.x - d.source.x,
          dy = d.target.y - d.source.y,
          dr = Math.sqrt(dx * dx + dy * dy);

        // If they are on the same Y (both Aggs), we arc up.
        // Agg Y is 250. Core Y is 50.
        // Control point X is mid, Y is near Core layer (e.g. 100).
        var midX = (d.source.x + d.target.x) / 2;
        var ctrlY = coreY + 50;

        return (
          "M" +
          d.source.x +
          "," +
          d.source.y +
          " Q" +
          midX +
          "," +
          ctrlY +
          " " +
          d.target.x +
          "," +
          d.target.y
        );
      } else {
        // Straight line
        return (
          "M" +
          d.source.x +
          "," +
          d.source.y +
          " L" +
          d.target.x +
          "," +
          d.target.y
        );
      }
    })
    .attr("stroke", (d) => (d.type === "ocs" ? "#9467bd" : "#ccc"))
    .attr("stroke-width", (d) => (d.type === "ocs" ? 2 : 1))
    .attr("fill", "none")
    .attr("opacity", (d) => (d.type === "ocs" ? 0.8 : 0.5));

  // Draw Nodes
  var allNodes = [];
  Object.values(topology.nodes).forEach((n) => allNodes.push(n));

  svg
    .selectAll(".node")
    .data(allNodes)
    .enter()
    .append("circle")
    .attr("class", (d) => d.type) // host, edge, agg, core
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", (d) => (d.type === "host" ? 3 : 6))
    .attr("fill", (d) => {
      if (d.type === "core") return "#d62728"; // Red
      if (d.type === "agg") return "#ff7f0e"; // Orange
      if (d.type === "edge") return "#1f77b4"; // Blue
      return "#2ca02c"; // Green (host)
    })
    .append("title")
    .text((d) => d.id);

  // Add labels for Pods
  for (var p = 0; p < numPods; p++) {
    var podX = p * podWidth + podWidth / 2 + 50;
    svg
      .append("text")
      .attr("x", podX)
      .attr("y", edgeY + 20)
      .attr("text-anchor", "middle")
      .attr("fill", "#999")
      .text("Pod " + p);
  }
}

// Helpers
function kpress(e) {
  if (e.which == 104) {
    // 'h'
    var c = $("div.control");
    if (c.is(":visible")) c.hide();
    else c.show();
  }
}

function formInit() {
  var form = d3.select("form");

  // Set default
  var fields = form.selectAll("[name=width]");
  fields.property("value", conf["width"]);

  var fieldsOCS = form.selectAll("[name=ocs]");
  fieldsOCS.property("value", conf["ocs"]);

  function confInt() {
    var val = parseInt(this.value);
    // Ensure k is even for proper fat tree construction
    if (this.name === "width") {
      if (val < 2) val = 2;
      if (val % 2 !== 0) val = val + 1;
      this.value = val;
    }

    conf[this.name] = val;
    rebuildAndRedraw();
  }

  function hook(name, func) {
    var fields = form.selectAll("[name=" + name + "]");
    fields.on("change", func);
    fields.each(func);
  }

  hook("depth", confInt);
  hook("width", confInt);
  hook("ocs", confInt);
}
