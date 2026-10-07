#!/usr/bin/env python3
"""Fail-closed authorization for confirmatory blind inference."""
import datetime
import hashlib
import json
import math
import re
from decimal import Decimal
from pathlib import Path

_FAMILY_ID = re.compile(r"^[A-Za-z0-9._-]+$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


def _json_string(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _number_text(value):
    if not math.isfinite(value):
        raise ValueError("gate config contains a non-finite number")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    text = repr(value).lower()
    if "e" not in text:
        return text
    mantissa, exponent_text = text.split("e", 1)
    exponent = int(exponent_text)
    if -6 <= exponent < 21:
        fixed = format(Decimal(text), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    sign = "+" if exponent >= 0 else ""
    return f"{mantissa}e{sign}{exponent}"


def stable_json(value):
    """Match the JS stable() encoder used by evaluate.mjs for JSON values."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number_text(value)
    if isinstance(value, list):
        return "[" + ",".join(stable_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("gate object keys must be strings")
        return "{" + ",".join(_json_string(key) + ":" + stable_json(value[key]) for key in sorted(value)) + "}"
    raise ValueError(f"unsupported value in gate config: {type(value).__name__}")


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def registry_digest(families):
    return _sha256(stable_json(sorted(families)))


def frozen_gate_digest(gate):
    canonical = dict(gate)
    canonical.pop("frozenConfigSha256", None)
    return _sha256(stable_json(canonical))


def authorize_blind_rows(rows, gate_path):
    """Require an immutable, frozen gate protocol before any blind generation."""
    path = Path(gate_path)
    try:
        gate = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"cannot read frozen gate file {path}: {exc}") from exc
    if not isinstance(gate, dict) or gate.get("schema") != "cfb.micro-generator-gates/1":
        raise ValueError("blind inference requires the micro-generator gate schema")
    if gate.get("status") != "frozen" or not isinstance(gate.get("blindFamilyRegistry"), dict) or gate["blindFamilyRegistry"].get("status") != "frozen":
        raise ValueError("blind inference requires frozen thresholds and a frozen new-family registry")
    if not isinstance(gate.get("gateId"), str) or not gate["gateId"]:
        raise ValueError("frozen gate config needs a gateId")
    freeze_at = gate.get("freezeAt")
    try:
        datetime.datetime.fromisoformat(str(freeze_at).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("frozen gate config has no valid freezeAt timestamp") from exc
    gate_hash = gate.get("frozenConfigSha256")
    if not isinstance(gate_hash, str) or not _SHA256.fullmatch(gate_hash):
        raise ValueError("frozen gate config hash is missing or malformed")
    if frozen_gate_digest(gate) != gate_hash:
        raise ValueError("frozen gate config hash does not match its contents")
    registry = gate.get("blindFamilyRegistry") or {}
    families = registry.get("families")
    if not isinstance(families, list) or not families or any(not isinstance(x, str) or not _FAMILY_ID.fullmatch(x) for x in families):
        raise ValueError("frozen blind registry must contain non-empty ASCII family ids")
    if len(set(families)) != len(families):
        raise ValueError("frozen blind registry contains duplicate families")
    registry_hash = registry.get("registrySha256")
    if not isinstance(registry_hash, str) or registry_digest(families) != registry_hash:
        raise ValueError("frozen blind registry hash does not match its families")
    known = gate.get("knownFamilyNames")
    if not isinstance(known, list) or any(not isinstance(x, str) for x in known):
        raise ValueError("knownFamilyNames must be a string array")
    known_overlap = sorted(set(families) & set(known))
    if known_overlap:
        raise ValueError("registered blind families are already known: " + ",".join(known_overlap))
    if not rows:
        raise ValueError("refusing an empty blind prediction run")
    row_families = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("blind inference rows must be JSON objects")
        if row.get("finalSplit") != "blind":
            raise ValueError(f"{row.get('caseId', '<missing>')}: blind inference input is not marked finalSplit=blind")
        family = row.get("family")
        if not isinstance(family, str) or not family:
            raise ValueError("blind inference row has no family id")
        if family not in families:
            raise ValueError(f"blind family {family!r} is not in the frozen registry")
        row_families.add(family)
    return {
        "gateId": gate["gateId"],
        "gateConfigSha256": gate_hash,
        "blindRegistrySha256": registry_hash,
        "families": sorted(row_families),
    }
