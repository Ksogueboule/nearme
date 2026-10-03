from flask import Flask, send_from_directory, jsonify
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

        result = w.statement_execution.execute(
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

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)