from __future__ import annotations

import os
import random
from typing import Optional

try:  # pragma: no cover - optional dependency
    import numpy as _np
except ImportError:  # pragma: no cover - numpy optional
    _np = None  # type: ignore[assignment]

try:  # pragma: no cover - optional dependency
    import torch as _torch
except ImportError:  # pragma: no cover - torch optional
    _torch = None  # type: ignore[assignment]


DEFAULT_SEED = 1337
_ENVIRONMENT_ENV_VARS = ("ENVIRONMENT", "DEPLOY_ENV", "APP_ENV", "NODE_ENV")
_PROD_ENV_VALUES = {"prod", "production"}
_LAST_SEED_RANDOM = False


def _current_environment() -> str:
    for envKey in _ENVIRONMENT_ENV_VARS:
        value = os.getenv(envKey)
        if value and value.strip():
            return value.strip().lower()
    return "dev"


def set_seed(seed: Optional[int] = None) -> int:
    """Configure deterministic behaviour across supported libraries."""

    global _LAST_SEED_RANDOM

    if seed is None:
        env_value = _current_environment()
        if env_value in _PROD_ENV_VALUES:
            value = random.SystemRandom().randint(1, 2**32 - 1)
            _LAST_SEED_RANDOM = True
        else:
            value = DEFAULT_SEED
            _LAST_SEED_RANDOM = False
    else:
        value = int(seed)
        _LAST_SEED_RANDOM = False
    random.seed(value)
    os.environ["PYTHONHASHSEED"] = str(value)

    if _np is not None:
        _np.random.seed(value)

    if _torch is not None:
        _torch.manual_seed(value)
        _torch.cuda.manual_seed_all(value)  # type: ignore[attr-defined]
        try:
            _torch.use_deterministic_algorithms(True, warn_only=True)  # type: ignore[attr-defined]
        except Exception:  # pragma: no cover - torch version guard
            pass

    return value


def seed_was_randomized() -> bool:
    return _LAST_SEED_RANDOM
