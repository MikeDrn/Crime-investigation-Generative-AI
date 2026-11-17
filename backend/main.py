"""
GenAI Studio server.
Run from the project root:  python -m uvicorn backend.main:app
Then open http://127.0.0.1:8000
"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend import config
from backend.services.registry import SERVICES

app = FastAPI(title="GenAI Studio", version="2.0.0")


@app.get("/api/health")
def health():
    return {"status": "ok", "device": config.WHISPER_DEVICE, "runs_locally": True}


@app.get("/api/services")
def list_services():
    return [service.info() for service in SERVICES]


for service in SERVICES:
    app.include_router(service.build_router(), prefix=f"/api/{service.id}", tags=[service.name])

# Serve the browser interface. Mounted last so /api routes take priority.
app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
