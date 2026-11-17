"""
The list of models shown in the studio.

To add a model: create backend/services/<name>_service.py with a class that
inherits AIService, import it here, and add an instance to SERVICES.
"""
from backend.services.restorer_service import RestorerService
from backend.services.summarizer_service import SummarizerService
from backend.services.text2image_service import Text2ImageService
from backend.services.whisper_service import WhisperService

SERVICES = [
    WhisperService(),
    SummarizerService(),
    RestorerService(),
    Text2ImageService(),
]
