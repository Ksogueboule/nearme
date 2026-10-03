// NearMe Route Finder \u2014 A* pathfinding on a severity grid
// Finds the least severe driving route between two points in North Carolina

let map = null;
let clemencyData = [];
let startMarker = null, endMarker = null;
let routeLayer = null, altRouteLayer = null, severityLayer = null, hazardLayer = null;
let allDataLayer = null, allDataVisible = false;
let weatherLayer = null, weatherVisible = false;
let startCoords = null, endCoords = null;

const CLEMENCY_COLORS = {
    Benign: '#2ecc71', Mild: '#f1c40f', Moderate: '#e67e22',
    Severe: '#e74c3c', Extreme: '#8e44ad'
};

// API base URL — same-origin on Databricks app, cross-origin from GitHub Pages
var API_BASE = window.location.hostname.includes('databricksapps.com')
    ? ''
    : 'https://nearme-route-finder-7474645519488303.aws.databricksapps.com';

// --- Chat widget ---
function toggleChat() {
    document.getElementById('chat-panel').classList.toggle('open');
}

function addChatMessage(role, text) {
    var msgs = document.getElementById('chat-messages');
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
}

async function sendChatMessage() {
    var input = document.getElementById('chat-input');
    var question = input.value.trim();
    if (!question) return;
    addChatMessage('user', question);
    input.value = '';

    var msgs = document.getElementById('chat-messages');
    var typing = document.createElement('div');
    typing.className = 'chat-msg bot';
    typing.id = 'chat-typing';
    typing.textContent = 'Thinking...';
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    var context = {};
    if (startCoords) context.start = startCoords.lat.toFixed(4) + ', ' + startCoords.lon.toFixed(4);
    if (endCoords) context.end = endCoords.lat.toFixed(4) + ', ' + endCoords.lon.toFixed(4);
    if (window._safeStats) context.safeStats = { distance: window._safeStats.distance, avgSeverity: window._safeStats.avgSeverity, rating: window._safeStats.rating };
    if (window._directStats) context.directStats = { distance: window._directStats.distance, avgSeverity: window._directStats.avgSeverity, rating: window._directStats.rating };

    try {
        var resp = await fetch(API_BASE + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: question, context: context })
        });
        var data = await resp.json();
        var t = document.getElementById('chat-typing');
        if (t) t.remove();
        var answer = data.answer || ('Error: ' + (data.error || 'Unknown'));
        // Parse action directive from agent response
        var actionMatch = answer.match(/\[ACTION:\s*(\{[^}]+\})\s*\]/i);
        if (actionMatch) {
            try {
                var action = JSON.parse(actionMatch[1]);
                answer = answer.replace(actionMatch[0], '').trim();
                addChatMessage('bot', answer);
                addChatMessage('bot', 'Setting up your route...');
                executeChatAction(action);
            } catch (e) { addChatMessage('bot', answer); }
        } else {
            addChatMessage('bot', answer);
        }
    } catch (e) {
        var t = document.getElementById('chat-typing');
        if (t) t.remove();
        addChatMessage('bot', 'Sorry, I could not connect to the AI agent. The Databricks app may be stopped.');
    }
}

// Execute route actions from the AI agent
async function executeChatAction(action) {
    if (action.type === 'find_route') {
        if (action.start) {
            var sc = await geocode(action.start);
            if (sc) setStart(sc.lat, sc.lon);
        }
        if (action.end) {
            var ec = await geocode(action.end);
            if (ec) setEnd(ec.lat, ec.lon);
        }
        if (startCoords && endCoords) await findRoute();
    } else if (action.type === 'set_start' && action.location) {
        var sc = await geocode(action.location);
        if (sc) { setStart(sc.lat, sc.lon); addChatMessage('bot', 'Start set to ' + action.location); }
    } else if (action.type === 'set_end' && action.location) {
        var ec = await geocode(action.location);
        if (ec) { setEnd(ec.lat, ec.lon); addChatMessage('bot', 'End set to ' + action.location); }
    }
}

function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([35.5, -79.2], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '\u00a9 OpenStreetMap', maxZoom: 18
    }).addTo(map);

    map.on('click', function(e) {
        if (!startCoords) {
            setStart(e.latlng.lat, e.latlng.lng);
        } else if (!endCoords) {
            setEnd(e.latlng.lat, e.latlng.lng);
        } else {
            clearRoute();
            setStart(e.latlng.lat, e.latlng.lng);
        }
    });
}

// Toggle all data points overlay
function toggleAllData() {
    if (!allDataLayer) {
        allDataLayer = L.layerGroup();
        for (var i = 0; i < clemencyData.length; i++) {
            var pt = clemencyData[i];
            var c = sevColor(pt[2]);
            L.circleMarker([pt[0], pt[1]], {
                radius: 3, color: c, fillColor: c, fillOpacity: 0.5, weight: 1
            }).bindPopup(
                '<b>' + pt[4] + '</b><br>Severity: ' + pt[2].toFixed(2) + ' (' + pt[5] + ')<br>' + (pt[6] || '')
            ).addTo(allDataLayer);
        }
    }
    if (allDataVisible) {
        allDataLayer.remove();
        allDataVisible = false;
        var btn = document.getElementById('toggle-data-btn');
        btn.textContent = 'Show All Data Points';
        btn.classList.remove('active');
        document.getElementById('data-count').textContent = '';
    } else {
        allDataLayer.addTo(map);
        allDataVisible = true;
        var btn = document.getElementById('toggle-data-btn');
        btn.textContent = 'Hide All Data Points';
        btn.classList.add('active');
        document.getElementById('data-count').textContent = clemencyData.length + ' data points visible';
    }
}

// Toggle weather overlay from NWS API (api.weather.gov) — active alerts for NC
function alertColor(event) {
    var e = (event || '').toLowerCase();
    if (e.indexOf('tornado') >= 0) return '#e74c3c';
    if (e.indexOf('severe thunderstorm') >= 0) return '#e67e22';
    if (e.indexOf('flash flood') >= 0) return '#8e44ad';
    if (e.indexOf('flood') >= 0) return '#f1c40f';
    if (e.indexOf('winter') >= 0 || e.indexOf('snow') >= 0 || e.indexOf('ice') >= 0) return '#3498db';
    if (e.indexOf('heat') >= 0) return '#e74c3c';
    if (e.indexOf('wind') >= 0) return '#1abc9c';
    if (e.indexOf('fire') >= 0) return '#e74c3c';
    if (e.indexOf('marine') >= 0 || e.indexOf('coastal') >= 0) return '#16a085';
    return '#95a5a6';
}

async function toggleWeather() {
    var btn = document.getElementById('toggle-weather-btn');
    if (weatherVisible) {
        if (weatherLayer) map.removeLayer(weatherLayer);
        weatherVisible = false;
        btn.textContent = 'Show Weather';
        btn.classList.remove('active');
        return;
    }
    btn.textContent = 'Loading weather...';
    try {
        var resp = await fetch('https://api.weather.gov/alerts/active?area=NC');
        var data = await resp.json();
        if (weatherLayer) map.removeLayer(weatherLayer);
        weatherLayer = L.layerGroup();
        var alertCount = 0;
        if (data.features) {
            for (var i = 0; i < data.features.length; i++) {
                var f = data.features[i];
                var event = f.properties.event || 'Weather Alert';
                var headline = f.properties.headline || event;
                var severity = f.properties.severity || 'Minor';
                var area = f.properties.areaDesc || '';
                var desc = (f.properties.description || '').substring(0, 300);
                var expires = f.properties.expires || '';
                var color = alertColor(event);
                if (f.geometry) {
                    L.geoJSON(f.geometry, {
                        style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.25 }
                    }).bindPopup(
                        '<b>' + event + '</b><br>' +
                        '<b>Severity:</b> ' + severity + '<br>' +
                        '<b>Area:</b> ' + area + '<br>' +
                        '<b>Expires:</b> ' + (expires ? new Date(expires).toLocaleString() : 'N/A') + '<br><br>' +
                        desc
                    ).addTo(weatherLayer);
                    alertCount++;
                }
            }
        }
        weatherLayer.addTo(map);
        weatherVisible = true;
        btn.textContent = alertCount > 0 ? 'Hide Weather (' + alertCount + ' alerts)' : 'Hide Weather (no active alerts)';
        btn.classList.add('active');
    } catch (e) {
        console.error('NWS weather fetch failed:', e);
        btn.textContent = 'Show Weather';
        btn.classList.remove('active');
    }
}

function setStart(lat, lon) {
    startCoords = { lat, lon };
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.circleMarker([lat, lon], {
        radius: 8, color: '#2ecc71', fillColor: '#2ecc71', fillOpacity: 0.8, weight: 3
    }).addTo(map).bindPopup('Start').openPopup();
    document.getElementById('start-coords').textContent = lat.toFixed(4) + ', ' + lon.toFixed(4);
}

function setEnd(lat, lon) {
    endCoords = { lat, lon };
    if (endMarker) map.removeLayer(endMarker);
    endMarker = L.circleMarker([lat, lon], {
        radius: 8, color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 0.8, weight: 3
    }).addTo(map).bindPopup('End').openPopup();
    document.getElementById('end-coords').textContent = lat.toFixed(4) + ', ' + lon.toFixed(4);
}

async function geocode(location) {
    location = location.trim();
    if (!location) return null;

    // Try to parse as coordinates: "35.78, -78.64", "35.78 -78.64", "(35.78,-78.64)"
    var coords = location.match(/\(?\s*(-?\d+\.?\d*)\s*[, ]+\s*(-?\d+\.?\d*)\s*\)?/);
    if (coords) {
        var lat = parseFloat(coords[1]), lon = parseFloat(coords[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
            return { lat: lat, lon: lon };
    }

    // Try ZIP code (5-digit)
    var zip = location.match(/^\d{5}$/);
    if (zip) location = zip[0] + ', NC';

    // Geocode via Nominatim — add NC context only if not already present
    var q = location;
    if (!/\b(NC|North Carolina|SC|South Carolina|VA|Virginia|GA|Tennessee|TN|USA)\b/i.test(q))
        q += ', North Carolina';

    try {
        var resp = await fetch('https://nominatim.openstreetmap.org/search?q=' +
            encodeURIComponent(q) + '&format=json&limit=1&addressdetails=1');
        var data = await resp.json();
        if (data && data[0]) {
            var r = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
            console.log('Geocoded "' + location + '" to ' + r.lat.toFixed(4) + ', ' + r.lon.toFixed(4));
            return r;
        }
    } catch (e) { console.error('Geocoding failed:', e); }
    return null;
}

// Build severity grid over the bounding box between start and end
function buildSeverityGrid(data, minLat, maxLat, minLon, maxLon) {
    var padLat = Math.max((maxLat - minLat) * 0.2, 0.05);
    var padLon = Math.max((maxLon - minLon) * 0.2, 0.05);
    var gridMinLat = minLat - padLat, gridMaxLat = maxLat + padLat;
    var gridMinLon = minLon - padLon, gridMaxLon = maxLon + padLon;

    var res = 0.005;
    var cols = Math.min(Math.ceil((gridMaxLon - gridMinLon) / res), 120);
    var rows = Math.min(Math.ceil((gridMaxLat - gridMinLat) / res), 120);
    var resLon = (gridMaxLon - gridMinLon) / cols;
    var resLat = (gridMaxLat - gridMinLat) / rows;

    var severity = [], counts = [];
    for (var r = 0; r < rows; r++) {
        severity.push(new Array(cols).fill(0));
        counts.push(new Array(cols).fill(0));
    }

    for (var i = 0; i < data.length; i++) {
        var pt = data[i];
        if (pt[0] < gridMinLat || pt[0] > gridMaxLat || pt[1] < gridMinLon || pt[1] > gridMaxLon) continue;
        var c = Math.floor((pt[1] - gridMinLon) / resLon);
        var r2 = Math.floor((pt[0] - gridMinLat) / resLat);
        if (r2 >= 0 && r2 < rows && c >= 0 && c < cols) {
            severity[r2][c] += pt[2];
            counts[r2][c]++;
        }
    }

    for (var r = 0; r < rows; r++)
        for (var c = 0; c < cols; c++)
            if (counts[r][c] > 0) severity[r][c] /= counts[r][c];

    return { grid: severity, rows: rows, cols: cols, gridMinLat: gridMinLat, gridMinLon: gridMinLon, resLat: resLat, resLon: resLon };
}

// A* pathfinding with 8-directional movement
// Cost = move_distance + cell_severity * 10 (strongly prefer low-severity areas)
function aStar(gd, sr, sc, er, ec, sevWeight) {
    sevWeight = sevWeight !== undefined ? sevWeight : 10;
    var dirs = [[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],[-1,-1,1.414],[-1,1,1.414],[1,-1,1.414],[1,1,1.414]];
    var open = [{ row: sr, col: sc, f: Math.sqrt((sr-er)**2 + (sc-ec)**2) }];
    var came = {}, gScore = {};
    gScore[sr + ',' + sc] = 0;

    while (open.length > 0) {
        open.sort(function(a, b) { return a.f - b.f; });
        var cur = open.shift();
        var ck = cur.row + ',' + cur.col;

        if (cur.row === er && cur.col === ec) {
            var path = [{ row: cur.row, col: cur.col }];
            var k = ck;
            while (came[k]) { path.unshift({ row: came[k].row, col: came[k].col }); k = came[k].row + ',' + came[k].col; }
            return path;
        }

        var curG = gScore[ck];
        for (var d = 0; d < dirs.length; d++) {
            var nr = cur.row + dirs[d][0], nc = cur.col + dirs[d][1], dist = dirs[d][2];
            if (nr < 0 || nr >= gd.rows || nc < 0 || nc >= gd.cols) continue;
            var sev = gd.grid[nr][nc];
            var cost = dist + sev * sevWeight;
            var tg = curG + cost;
            var nk = nr + ',' + nc;
            if (gScore[nk] === undefined || tg < gScore[nk]) {
                came[nk] = { row: cur.row, col: cur.col };
                gScore[nk] = tg;
                open.push({ row: nr, col: nc, f: tg + Math.sqrt((nr - er) ** 2 + (nc - ec) ** 2) });
            }
        }
    }
    return null;
}

// Snap A* waypoints to actual roads via OSRM public API
async function snapToRoads(coords) {
    var step = Math.max(1, Math.floor(coords.length / 20));
    var wps = [];
    for (var i = 0; i < coords.length; i += step)
        wps.push(coords[i][1].toFixed(6) + ',' + coords[i][0].toFixed(6));
    var last = coords[coords.length - 1];
    var lastWp = last[1].toFixed(6) + ',' + last[0].toFixed(6);
    if (wps[wps.length - 1] !== lastWp) wps.push(lastWp);
    var url = 'https://router.project-osrm.org/route/v1/driving/' + wps.join(';') + '?overview=full&geometries=geojson';
    try {
        var resp = await fetch(url);
        var data = await resp.json();
        if (data.code === 'Ok' && data.routes && data.routes[0]) {
            var geom = data.routes[0].geometry;
            if (geom.type === 'LineString')
                return geom.coordinates.map(function(c) { return [c[1], c[0]]; });
        }
    } catch (e) { console.error('OSRM routing failed:', e); }
    return coords;
}

// Analyze severity along a route
function analyzeRoute(routeCoords) {
    var totalSev = 0, maxSev = 0, sp = [];
    for (var i = 0; i < routeCoords.length; i++) {
        var lat = routeCoords[i][0], lon = routeCoords[i][1];
        var cellSev = 0, hazards = [];
        for (var j = 0; j < clemencyData.length; j++) {
            var pt = clemencyData[j];
            var dLat = pt[0] - lat, dLon = pt[1] - lon;
            if (Math.sqrt(dLat * dLat + dLon * dLon) < 0.02) {
                cellSev = Math.max(cellSev, pt[2]);
                if (hazards.length < 3) hazards.push(pt);
            }
        }
        totalSev += cellSev;
        if (cellSev > maxSev) maxSev = cellSev;
        if (cellSev > 0.1) sp.push({ lat: lat, lon: lon, severity: cellSev, hazards: hazards });
    }
    var avgSev = totalSev / routeCoords.length;
    var dist = 0;
    for (var i = 1; i < routeCoords.length; i++)
        dist += haversine(routeCoords[i - 1][0], routeCoords[i - 1][1], routeCoords[i][0], routeCoords[i][1]);
    var rating = 'Benign';
    if (avgSev > 0.5) rating = 'Extreme';
    else if (avgSev > 0.4) rating = 'Severe';
    else if (avgSev > 0.25) rating = 'Moderate';
    else if (avgSev > 0.1) rating = 'Mild';
    return { avgSeverity: avgSev, maxSeverity: maxSev, distance: dist, rating: rating, severityPoints: sp };
}

async function findRoute() {
    // Always re-read input fields — if they have content, geocode fresh (overrides cached coords)
    var si = document.getElementById('start-input').value.trim();
    if (si) {
        var sc = await geocode(si);
        if (sc) { setStart(sc.lat, sc.lon); }
        else { document.getElementById('results').innerHTML = '<p class="error">Could not find "' + si + '". Try a street address, city, ZIP code, landmark, or coordinates.</p>'; return; }
    }
    var ei = document.getElementById('end-input').value.trim();
    if (ei) {
        var ec = await geocode(ei);
        if (ec) { setEnd(ec.lat, ec.lon); }
        else { document.getElementById('results').innerHTML = '<p class="error">Could not find "' + ei + '". Try a street address, city, ZIP code, landmark, or coordinates.</p>'; return; }
    }
    if (!startCoords || !endCoords) { alert('Please set both start and end locations.'); return; }

    document.getElementById('results').innerHTML = '<p style="color:#3498db">Computing safest and direct routes...</p>';

    var minLat = Math.min(startCoords.lat, endCoords.lat);
    var maxLat = Math.max(startCoords.lat, endCoords.lat);
    var minLon = Math.min(startCoords.lon, endCoords.lon);
    var maxLon = Math.max(startCoords.lon, endCoords.lon);

    var gd = buildSeverityGrid(clemencyData, minLat, maxLat, minLon, maxLon);
    var sr = Math.floor((startCoords.lat - gd.gridMinLat) / gd.resLat);
    var sc = Math.floor((startCoords.lon - gd.gridMinLon) / gd.resLon);
    var er = Math.floor((endCoords.lat - gd.gridMinLat) / gd.resLat);
    var ec = Math.floor((endCoords.lon - gd.gridMinLon) / gd.resLon);
    sr = Math.max(0, Math.min(gd.rows - 1, sr)); sc = Math.max(0, Math.min(gd.cols - 1, sc));
    er = Math.max(0, Math.min(gd.rows - 1, er)); ec = Math.max(0, Math.min(gd.cols - 1, ec));

    // Compute safest route (high severity weight) and direct route (no severity weight)
    var safePath = aStar(gd, sr, sc, er, ec, 10);
    var directPath = aStar(gd, sr, sc, er, ec, 0);
    if (!safePath) { document.getElementById('results').innerHTML = '<p class="error">No route found. Try different points.</p>'; return; }

    // Convert grid paths to lat/lon
    var safeCoords = safePath.map(function(p) { return [gd.gridMinLat + p.row * gd.resLat, gd.gridMinLon + p.col * gd.resLon]; });
    var directCoords = directPath ? directPath.map(function(p) { return [gd.gridMinLat + p.row * gd.resLat, gd.gridMinLon + p.col * gd.resLon]; }) : null;

    // Snap both routes to actual roads via OSRM
    var safeRoad = await snapToRoads(safeCoords);
    var directRoad = directCoords ? await snapToRoads(directCoords) : null;

    // Analyze severity along both routes
    var safeStats = analyzeRoute(safeRoad);
    var directStats = directRoad ? analyzeRoute(directRoad) : null;

    displayRoute(safeRoad, directRoad, safeStats, directStats);
}

// Export utilities — Google Maps, Apple Maps links, GPX, CSV
function toGoogleMapsUrl(routeCoords) {
    var maxWps = 10;
    var step = Math.max(1, Math.floor(routeCoords.length / maxWps));
    var pts = [];
    for (var i = 0; i < routeCoords.length; i += step)
        pts.push(routeCoords[i][0].toFixed(5) + ',' + routeCoords[i][1].toFixed(5));
    var last = routeCoords[routeCoords.length - 1];
    var lastPt = last[0].toFixed(5) + ',' + last[1].toFixed(5);
    if (pts[pts.length - 1] !== lastPt) pts.push(lastPt);
    return 'https://www.google.com/maps/dir/' + pts.join('/');
}

function toAppleMapsUrl(routeCoords) {
    var start = routeCoords[0];
    var end = routeCoords[routeCoords.length - 1];
    return 'https://maps.apple.com/?saddr=' + start[0].toFixed(5) + ',' + start[1].toFixed(5) +
        '&daddr=' + end[0].toFixed(5) + ',' + end[1].toFixed(5) + '&dirflg=d';
}

function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
}

function toGPX(routeCoords, name) {
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<gpx version="1.1" creator="NearMe Route Finder" xmlns="http://www.topografix.com/GPX/1/1">\n';
    xml += '<trk><name>' + name + '</name><trkseg>\n';
    for (var i = 0; i < routeCoords.length; i++) {
        xml += '<trkpt lat="' + routeCoords[i][0].toFixed(6) + '" lon="' + routeCoords[i][1].toFixed(6) + '"></trkpt>\n';
    }
    xml += '</trkseg></trk>\n</gpx>';
    downloadFile(name.replace(/\s+/g, '_') + '.gpx', xml, 'application/gpx+xml');
}

function toCSV(routeCoords, stats, name) {
    var csv = 'latitude,longitude,severity,distance_km,clemency\n';
    var dist = 0;
    for (var i = 0; i < routeCoords.length; i++) {
        if (i > 0) dist += haversine(routeCoords[i-1][0], routeCoords[i-1][1], routeCoords[i][0], routeCoords[i][1]);
        csv += routeCoords[i][0].toFixed(6) + ',' + routeCoords[i][1].toFixed(6) + ',' +
               (stats ? stats.avgSeverity.toFixed(3) : '') + ',' + dist.toFixed(2) + ',' +
               (stats ? stats.rating : '') + '\n';
    }
    downloadFile(name.replace(/\s+/g, '_') + '.csv', csv, 'text/csv');
}

function displayRoute(safeRoad, directRoad, safeStats, directStats) {
    if (routeLayer) map.removeLayer(routeLayer);
    if (altRouteLayer) map.removeLayer(altRouteLayer);
    if (severityLayer) map.removeLayer(severityLayer);
    if (hazardLayer) map.removeLayer(hazardLayer);

    // Safest route — blue solid line on roads
    routeLayer = L.polyline(safeRoad, { color: '#3498db', weight: 5, opacity: 0.85 }).addTo(map);

    // Direct (worse) route — red dashed line on roads
    if (directRoad) {
        altRouteLayer = L.polyline(directRoad, { color: '#e74c3c', weight: 3, opacity: 0.6, dashArray: '8,8' }).addTo(map);
    }

    // Fit bounds to show both routes
    var bounds = routeLayer.getBounds();
    if (altRouteLayer) bounds.extend(altRouteLayer.getBounds());
    map.fitBounds(bounds, { padding: [50, 50] });

    // Severity markers along safest route
    var sp = safeStats.severityPoints;
    severityLayer = L.layerGroup();
    var step = Math.max(1, Math.floor(sp.length / 50));
    for (var i = 0; i < sp.length; i += step) {
        var c = sevColor(sp[i].severity);
        L.circleMarker([sp[i].lat, sp[i].lon], { radius: 5, color: c, fillColor: c, fillOpacity: 0.6, weight: 1 }).addTo(severityLayer);
    }
    severityLayer.addTo(map);

    // Hazard markers
    hazardLayer = L.layerGroup();
    var shown = {};
    for (var i = 0; i < sp.length; i++) {
        for (var j = 0; j < sp[i].hazards.length; j++) {
            var h = sp[i].hazards[j];
            var hk = h[0].toFixed(4) + ',' + h[1].toFixed(4);
            if (shown[hk]) continue;
            shown[hk] = true;
            var c = sevColor(h[2]);
            L.circleMarker([h[0], h[1]], { radius: 3, color: c, fillColor: c, fillOpacity: 0.4, weight: 1 })
                .bindPopup('<b>' + h[4] + '</b><br>Severity: ' + h[2].toFixed(2) + ' (' + h[5] + ')<br>' + (h[6] || ''))
                .addTo(hazardLayer);
        }
    }
    hazardLayer.addTo(map);

    // Results panel — show both routes with comparison
    var safeColor = CLEMENCY_COLORS[safeStats.rating] || '#888';
    var html = '<div class="result-card" style="border-left-color:#3498db">' +
        '<h3 style="color:#3498db">Safest Route (blue)</h3>' +
        '<div class="result-stat"><span>Distance:</span> <b>' + safeStats.distance.toFixed(1) + ' km</b></div>' +
        '<div class="result-stat"><span>Avg Severity:</span> <b>' + safeStats.avgSeverity.toFixed(3) + '</b></div>' +
        '<div class="result-stat"><span>Max Severity:</span> <b>' + safeStats.maxSeverity.toFixed(3) + '</b></div>' +
        '<div class="result-stat"><span>Clemency:</span> <b style="color:' + safeColor + '">' + safeStats.rating + '</b></div>' +
        '</div>';

    if (directStats) {
        var directColor = CLEMENCY_COLORS[directStats.rating] || '#888';
        var sevDiff = (directStats.avgSeverity - safeStats.avgSeverity).toFixed(3);
        var distDiff = (directStats.distance - safeStats.distance).toFixed(1);
        html += '<div class="result-card" style="border-left-color:#e74c3c;margin-top:8px">' +
            '<h3 style="color:#e74c3c">Direct Route (red dashed)</h3>' +
            '<div class="result-stat"><span>Distance:</span> <b>' + directStats.distance.toFixed(1) + ' km</b></div>' +
            '<div class="result-stat"><span>Avg Severity:</span> <b>' + directStats.avgSeverity.toFixed(3) + '</b></div>' +
            '<div class="result-stat"><span>Max Severity:</span> <b>' + directStats.maxSeverity.toFixed(3) + '</b></div>' +
            '<div class="result-stat"><span>Clemency:</span> <b style="color:' + directColor + '">' + directStats.rating + '</b></div>' +
            '</div>' +
            '<div class="result-card" style="border-left-color:#2ecc71;margin-top:8px">' +
            '<h3 style="color:#2ecc71">Comparison</h3>' +
            '<div class="result-stat"><span>Extra distance:</span> <b>+' + distDiff + ' km</b></div>' +
            '<div class="result-stat"><span>Severity avoided:</span> <b>' + sevDiff + '</b></div>' +
            '</div>';
    }

    // Store routes globally for export button onclick handlers
    window._safeRoad = safeRoad;
    window._directRoad = directRoad;
    window._safeStats = safeStats;

    // Export section
    html += '<div class="export-section">' +
        '<h3>Export Directions</h3>' +
        '<div class="export-btns">' +
        '<a class="export-btn gmaps" href="' + toGoogleMapsUrl(safeRoad) + '" target="_blank">Google Maps (safest)</a>' +
        '<a class="export-btn apple" href="' + toAppleMapsUrl(safeRoad) + '" target="_blank">Apple Maps (safest)</a>' +
        (directRoad ? '<a class="export-btn gmaps" href="' + toGoogleMapsUrl(directRoad) + '" target="_blank">Google Maps (direct)</a>' : '') +
        (directRoad ? '<a class="export-btn apple" href="' + toAppleMapsUrl(directRoad) + '" target="_blank">Apple Maps (direct)</a>' : '') +
        '<button class="export-btn" onclick="toGPX(window._safeRoad, \'Safest Route\')">GPX (safest)</button>' +
        (directRoad ? '<button class="export-btn" onclick="toGPX(window._directRoad, \'Direct Route\')">GPX (direct)</button>' : '') +
        '<button class="export-btn" onclick="toCSV(window._safeRoad, window._safeStats, \'Safest Route\')">CSV (safest)</button>' +
        '</div>' +
        '</div>';

    document.getElementById('results').innerHTML = html;
}

function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function sevColor(s) {
    if (s > 0.5) return '#8e44ad';
    if (s > 0.4) return '#e74c3c';
    if (s > 0.25) return '#e67e22';
    if (s > 0.1) return '#f1c40f';
    return '#2ecc71';
}

function clearRoute() {
    if (routeLayer) map.removeLayer(routeLayer);
    if (altRouteLayer) map.removeLayer(altRouteLayer);
    if (severityLayer) map.removeLayer(severityLayer);
    if (hazardLayer) map.removeLayer(hazardLayer);
    if (startMarker) map.removeLayer(startMarker);
    if (endMarker) map.removeLayer(endMarker);
    startCoords = null; endCoords = null;
    startMarker = null; endMarker = null;
    routeLayer = null; altRouteLayer = null; severityLayer = null; hazardLayer = null;
    document.getElementById('start-coords').textContent = '';
    document.getElementById('end-coords').textContent = '';
    document.getElementById('results').innerHTML = '';
    document.getElementById('start-input').value = '';
    document.getElementById('end-input').value = '';
}

// Fallback data generator \u2014 realistic NC distribution when clemency_data.json is unavailable
function generateFallbackData() {
    var data = [];
    // NCGS Landslides \u2014 western NC mountains
    for (var i = 0; i < 2000; i++) {
        var lat = 35.0 + Math.random() * 1.2, lon = -84.0 + Math.random() * 1.5;
        var s = 0.2 + Math.random() * 0.6;
        data.push([lat, lon, s, 1 - s, 'NCGS Landslide', s > 0.5 ? 'Severe' : 'Moderate', 'Road']);
    }
    // NCEM Flood Zones \u2014 eastern NC coastal plain
    for (var i = 0; i < 1500; i++) {
        var lat = 33.5 + Math.random() * 2.5, lon = -78.5 + Math.random() * 3.0;
        var s = 0.3 + Math.random() * 0.5;
        data.push([lat, lon, s, 1 - s, 'NCEM Flood Zone', s > 0.5 ? 'Severe' : 'Mild', 'AE']);
    }
    // NCDOT Crashes \u2014 along major NC highways
    var hwys = [[[34.2,-77.9],[35.5,-78.7],[35.9,-79.1],[35.6,-80.5],[35.6,-82.5]],
                [[35.2,-80.8],[35.4,-80.0],[35.9,-78.8],[36.0,-78.5]],
                [[34.0,-78.4],[35.0,-78.3],[35.8,-78.2],[36.5,-78.0]]];
    for (var i = 0; i < 1500; i++) {
        var h = hwys[Math.floor(Math.random() * hwys.length)];
        var seg = h[Math.floor(Math.random() * h.length)];
        var lat = seg[0] + (Math.random() - 0.5) * 0.3, lon = seg[1] + (Math.random() - 0.5) * 0.3;
        var s = 0.3 + Math.random() * 0.4;
        data.push([lat, lon, s, 1 - s, 'NCDOT Crash', s > 0.5 ? 'Severe' : 'Mild', 'Highway']);
    }
    // IRWIN Fires \u2014 coastal and Piedmont forests
    for (var i = 0; i < 100; i++) {
        var lat = 34.0 + Math.random() * 2.0, lon = -80.0 + Math.random() * 4.0;
        var s = 0.05 + Math.random() * 0.4;
        data.push([lat, lon, s, 1 - s, 'IRWIN Fire', 'Benign', 'Prescribed Burn']);
    }
    // USGS Water \u2014 along rivers across NC
    for (var i = 0; i < 200; i++) {
        var lat = 34.0 + Math.random() * 2.5, lon = -82.0 + Math.random() * 6.5;
        var s = 0.01 + Math.random() * 0.4;
        data.push([lat, lon, s, 1 - s, 'USGS Water', 'Benign', 'Gage height']);
    }
    // NOAA Weather \u2014 across NC
    for (var i = 0; i < 50; i++) {
        var lat = 34.5 + Math.random() * 2.0, lon = -81.0 + Math.random() * 5.0;
        var s = 0.02 + Math.random() * 0.12;
        data.push([lat, lon, s, 1 - s, 'NOAA Weather', 'Benign', 'Temperature']);
    }
    // EPA Air Quality \u2014 Raleigh
    data.push([35.78, -78.64, 0.1, 0.9, 'EPA Air Quality', 'Benign', 'Good']);
    return data;
}

async function loadData() {
    // Try live API endpoint (Databricks app backend) first
    var API_URL = API_BASE + '/api/clemency';
    try {
        var resp = await fetch(API_URL);
        if (resp.ok) {
            clemencyData = await resp.json();
            if (Array.isArray(clemencyData) && clemencyData.length > 0) {
                console.log('Loaded ' + clemencyData.length + ' data points from live API');
                return;
            }
        }
    } catch (e) { console.log('Live API not available, trying local file...'); }

    // Fall back to static JSON file
    try {
        var resp = await fetch('clemency_data.json');
        if (resp.ok) {
            clemencyData = await resp.json();
            if (Array.isArray(clemencyData) && clemencyData.length > 0) {
                console.log('Loaded ' + clemencyData.length + ' data points from local file');
                return;
            }
        }
    } catch (e) { console.log('Local file not available, using fallback data'); }

    // Final fallback: generate synthetic data
    console.log('Using generated fallback data');
    clemencyData = generateFallbackData();
    console.log('Generated ' + clemencyData.length + ' fallback data points');
}

// Auto-refresh polling
var REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
var refreshTimer = null;
var lastRefreshTime = null;
var lastDataHash = '';

function dataHash(data) {
    var h = data.length + ':';
    for (var i = 0; i < Math.min(10, data.length); i++)
        h += data[i][0] + ',' + data[i][1] + ',' + data[i][2] + ';';
    var tail = data.length - 1;
    if (tail >= 0) h += data[tail][0] + ',' + data[tail][1] + ',' + data[tail][2];
    return h;
}

async function refreshData() {
    try {
        var resp = await fetch(API_BASE + '/api/clemency');
        if (!resp.ok) return;
        var newData = await resp.json();
        if (!Array.isArray(newData) || newData.length === 0) return;

        var newHash = dataHash(newData);
        if (newHash !== lastDataHash) {
            clemencyData = newData;
            lastDataHash = newHash;
            console.log('Data refreshed: ' + newData.length + ' entries (changed)');
            // Recompute route if one is active
            if (startCoords && endCoords && routeLayer) {
                console.log('Recomputing route with refreshed data...');
                findRoute();
            }
            // Rebuild all-data overlay if visible
            if (allDataVisible) {
                if (allDataLayer) { allDataLayer.remove(); allDataLayer = null; }
                allDataVisible = false;
                toggleAllData();
            }
            // Rebuild weather if visible
            if (weatherVisible) {
                if (weatherLayer) { map.removeLayer(weatherLayer); weatherLayer = null; }
                weatherVisible = false;
                toggleWeather();
            }
        } else {
            console.log('Data refreshed: no changes detected');
        }
        lastRefreshTime = new Date();
        updateRefreshIndicator();
    } catch (e) { console.log('Refresh failed:', e); }
}

function updateRefreshIndicator() {
    var el = document.getElementById('data-status');
    if (!el || !lastRefreshTime) return;
    var secs = Math.floor((new Date() - lastRefreshTime) / 1000);
    var txt = secs < 60 ? secs + 's ago' : Math.floor(secs / 60) + 'm ago';
    el.innerHTML = '<span class="status-dot live"></span> Live \u00b7 Updated ' + txt;
}

function startAutoRefresh() {
    setInterval(refreshData, REFRESH_INTERVAL);
    setInterval(updateRefreshIndicator, 10000);
}

window.addEventListener('load', async function() {
    initMap();
    await loadData();
    lastRefreshTime = new Date();
    lastDataHash = dataHash(clemencyData);
    updateRefreshIndicator();
    startAutoRefresh();
});
