"""Validate mobile schema directly with SQLite: FK/FTS/revisions and isolation.
Runtime SQLCipher/key use is separately tested by Expo Jest on Android/iOS code."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

SCHEMA_SOURCE = (
    Path(__file__).resolve().parents[2] / "mobile" / "src" / "local-memory" / "storage.ts"
)


def test_offline_schema_foreign_keys_fts_and_history():
    source = SCHEMA_SOURCE.read_text(encoding="utf-8")
    sql = re.search(r"export const SCHEMA_SQL = `(.*?)`;", source, re.DOTALL)
    assert sql, "schema SQL was not found"
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(sql.group(1))
    connection.execute("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES(?,?,?,?,?)",
                       ("notes", "Notes", "notes", "standard", "2026-10-09"))
    connection.execute("""INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""", ("n1", "notes", "notes", "Car", '{"body":"oil"}', "2026", "2026"))
    connection.execute("""INSERT INTO memory_entities(id,collection_id,domain,title,payload_json,created_at,updated_at)
                       VALUES(?,?,?,?,?,?,?)""", ("n2", "notes", "notes", "Garage", '{"body":"service"}', "2026", "2026"))
    connection.execute("INSERT INTO memory_notes_fts(entity_id,title,body) VALUES(?,?,?)",
                       ("n1", "Car", "oil replacement"))
    assert connection.execute("SELECT entity_id FROM memory_notes_fts WHERE memory_notes_fts MATCH ?",
                              ('"oil replacement"',)).fetchone() == ("n1",)
    connection.execute("""INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,created_at)
                       VALUES (?,?,?,?,?)""", ("r1", "n1", "n2", "related_to", "2026"))
    connection.execute("""INSERT INTO memory_observations(id,entity_id,kind,payload_json,occurred_at,created_at)
                       VALUES(?,?,?,?,?,?)""", ("o1", "n1", "note_event", '{"text":"oil"}', "2026", "2026"))
    connection.execute("""INSERT INTO memory_revisions
          (id,record_type,entity_id,version,reason,actor_kind,before_json,after_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)""", ("v1", "entity", "n1", 2, "corrected", "user", "{}", "{}", "2026"))
    with __import__("pytest").raises(sqlite3.IntegrityError):
        connection.execute("""INSERT INTO memory_relations(id,source_entity_id,target_entity_id,kind,created_at)
                           VALUES(?,?,?,?,?)""", ("self", "n1", "n1", "related_to", "2026"))
    with __import__("pytest").raises(sqlite3.IntegrityError):
        connection.execute("""INSERT INTO memory_revisions
          (id,record_type,entity_id,version,reason,actor_kind,before_json,after_json,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)""", ("dup", "entity", "n1", 2, "duplicate", "user", "{}", "{}", "2026"))
    connection.execute("DELETE FROM memory_entities WHERE id = 'n1'")
    assert connection.execute("SELECT COUNT(*) FROM memory_relations").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM memory_revisions").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM memory_observations").fetchone()[0] == 0
