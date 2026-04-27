# MoST Local API

This folder contains a local Node.js API to expose experiment data under `../requests` for a local dashboard.

## Run

```bash
cd api
npm install
npm start
```

By default, the API listens on `http://localhost:4000`.

## Endpoints

- `GET /health`
- `GET /api/llm-name`
- `GET /api/gpu-used`
- `GET /api/results-scopes`
- `GET /api/experiments`
- `GET /api/experiments/:experiment/iterations`
- `GET /api/experiments/:experiment/iterations/:iteration/results.csv`
- `GET /api/experiments/:experiment/iterations/:iteration/download/results.csv`
- `GET /api/experiments/:experiment/iterations/:iteration/download/results.json`

## Notes

- The API reads `../.env` first (project root), then `api/.env` if present.
- `llm-name` and `gpu-used` are resolved from environment values first, then latest iteration result files.
- The `results.csv` endpoint returns parsed rows as JSON for dashboard consumption.
- Download endpoints return the raw files.
- Experiment endpoints accept `?resultsScope=current|MST-1|MST-2|...`.
- `current` reads from `requests/` directly, while other scopes read from subfolders like `requests/MST-1/`.
