from flask import Flask, send_from_directory, jsonify, request
import os, time

app = Flask(__name__, static_folder='.', static_url_path='')

# CORS: allow GitHub Pages to call the API cross-origin
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
    response.headers.add('Access-Control-Allow-Methods', 'GET, OPTIONS')
    return response

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/health')
def health():
    return {'status': 'ok'}

# In-memory cache (5-minute TTL) to avoid hammering the warehouse
_clemency_cache = {'data': None, 'ts': 0}
CACHE_TTL = 300

@app.route('/api/clemency')
def api_clemency():
    now = time.time()
    if _clemency_cache['data'] is not None and now - _clemency_cache['ts'] < CACHE_TTL:
        return jsonify(_clemency_cache['data'])

    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()

        # Find a running SQL warehouse
        warehouse_id = None
        for wh in w.warehouses.list():
            if wh.state == 'RUNNING':
                warehouse_id = wh.id
                break
        if not warehouse_id:
            whs = list(w.warehouses.list())
            if whs:
                warehouse_id = whs[0].id
        if not warehouse_id:
            return jsonify({'error': 'No SQL warehouse available'}), 503

        result = w.statement_execution.execute_statement(
            warehouse_id=warehouse_id,
            statement="SELECT latitude, longitude, severity_score, "
                      "clemency_score, source_type, kmeans_clemency, detail "
                      "FROM workspace.default.clemency_labeled "
                      "WHERE latitude IS NOT NULL AND longitude IS NOT NULL",
            wait_timeout="300s",
            byte_limit=100_000_000,
        )

        if result.status.state != 'SUCCEEDED':
            return jsonify({'error': f'Query state: {result.status.state}'}), 500
        if not result.result or not result.result.data_array:
            return jsonify({'error': 'No data returned'}), 500

        data = []
        for row in result.result.data_array:
            data.append([
                round(float(row[0]), 5),
                round(float(row[1]), 5),
                round(float(row[2]), 3),
                round(float(row[3]), 3),
                row[4] or '',
                row[5] or '',
                (row[6] or '')[:60],
            ])

        _clemency_cache['data'] = data
        _clemency_cache['ts'] = now
        print(f'Loaded {len(data)} rows from clemency_labeled')
        return jsonify(data)
    except Exception as e:
        print(f'API error: {e}')
        return jsonify({'error': str(e)}), 500

@app.route('/api/chat', methods=['POST', 'OPTIONS'])
def api_chat():
    if request.method == 'OPTIONS':
        return '', 204
    try:
        data = request.get_json(force=True)
        question = data.get('question', '')
        ctx = data.get('context', {})

        system_prompt = (
            "You are the NearMe AI assistant, an environmental hazard routing expert for North Carolina. "
            "You help users understand route safety, hazard conditions, and environmental data.\n\n"
            "NearMe analyzes 7 data sources across NC:\n"
            "- EPA Air Quality (AQI)\n"
            "- NOAA Weather (temperature, wind, humidity)\n"
            "- USGS Water (gage heights)\n"
            "- NCDOT Crashes (traffic incidents)\n"
            "- NCGS Landslides (impact, damage, fatalities)\n"
            "- NCEM Flood Zones (flood depth)\n"
            "- IRWIN Wildland Fires (fire size, containment)\n\n"
            "Routes are scored 0-1 severity and classified: Benign, Mild, Moderate, Severe, Extreme. "
            "The app finds the safest route by minimizing total environmental severity via A* pathfinding.\n"
            "Keep answers concise (2-3 sentences). Be helpful and specific.\n\n"
            "ACTION PROTOCOL: If the user asks to find a route, plan a trip, or set start/end locations, "
            "append an action directive at the END of your response in this exact format:\n"
            '[ACTION:{"type":"find_route","start":"City, NC","end":"City, NC"}]\n'
            "For setting only start or end:\n"
            '[ACTION:{"type":"set_start","location":"City, NC"}]\n'
            '[ACTION:{"type":"set_end","location":"City, NC"}]\n'
            "Only include the action block when the user explicitly requests a route or location. "
            "Do not include it for informational questions. Use full place names (e.g. 'Raleigh, NC')."
        )

        if ctx:
            system_prompt += "\n\nCurrent route context:\n"
            if ctx.get('start'): system_prompt += f"Start: {ctx['start']}\n"
            if ctx.get('end'): system_prompt += f"End: {ctx['end']}\n"
            if ctx.get('safeStats'):
                s = ctx['safeStats']
                system_prompt += f"Safest route: {s.get('distance',0):.1f} km, avg severity {s.get('avgSeverity',0):.3f}, clemency: {s.get('rating','?')}\n"
            if ctx.get('directStats'):
                d = ctx['directStats']
                system_prompt += f"Direct route: {d.get('distance',0):.1f} km, avg severity {d.get('avgSeverity',0):.3f}, clemency: {d.get('rating','?')}\n"
            if ctx.get('hazards'):
                system_prompt += f"Nearby hazards: {ctx['hazards']}\n"

        from databricks.sdk import WorkspaceClient
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
        w = WorkspaceClient()
        response = w.serving_endpoints.query(
            name="databricks-llama-4-maverick",
            messages=[
                ChatMessage(role=ChatMessageRole.SYSTEM, content=system_prompt),
                ChatMessage(role=ChatMessageRole.USER, content=question),
            ]
        )
        answer = response.choices[0].message.content
        return jsonify({'answer': answer})
    except Exception as e:
        print(f'Chat API error: {e}')
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)