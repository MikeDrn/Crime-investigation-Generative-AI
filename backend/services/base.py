"""
Base class every AI model in the studio inherits from.

Each service:
  * describes itself (id, name, description, category) so the interface can list it
  * builds its own FastAPI router, mounted at /api/<id>/...
The browser loads a matching module at frontend/js/tools/<id>.js to draw its screen.
"""
from abc import ABC, abstractmethod

from fastapi import APIRouter


class AIService(ABC):
    id: str = ""            # short, URL-safe; must match frontend/js/tools/<id>.js
    name: str = ""          # shown in the sidebar
    description: str = ""   # one sentence shown under the title
    category: str = ""      # e.g. "Audio to text", "Text to image"

    def info(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "category": self.category,
        }

    @abstractmethod
    def build_router(self) -> APIRouter:
        """Return the API routes for this model."""
