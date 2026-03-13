from pathlib import Path
from pydantic_settings import BaseSettings

# The .env file lives at the project root (one level above this file).
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    OPENSKY_CLIENT_ID: str = ""
    OPENSKY_CLIENT_SECRET: str = ""
    OPENSKY_USERNAME: str = ""
    OPENSKY_PASSWORD: str = ""
    ADSB_API_KEY: str = ""
    POLLING_INTERVAL_SECONDS: int = 10
    MAX_SATELLITES: int = 500
    TRAIL_MAX_LENGTH: int = 10
    METADATA_FETCH_PER_CYCLE: int = 5

    class Config:
        env_file = str(_ENV_FILE)
        extra = "ignore"


settings = Settings()
