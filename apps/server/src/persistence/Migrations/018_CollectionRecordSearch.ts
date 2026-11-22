import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The WITHOUT ROWID table's primary key shares its pages with the full record values.
  yield* sql`CREATE INDEX collection_record_keys ON collection_records (collection_id, key)`;
  yield* sql`CREATE TABLE collection_record_search (
    collection_id TEXT NOT NULL,
    key TEXT NOT NULL,
    field_values BLOB NOT NULL,
    PRIMARY KEY (collection_id, key),
    FOREIGN KEY (collection_id, key) REFERENCES collection_records (collection_id, key)
      ON UPDATE CASCADE ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE VIEW collection_search_fields AS
    SELECT c.id AS collection_id, field.value AS field_id
    FROM collections c, json_each(c.layout, '$.search.fields') field
    UNION
    SELECT c.id, choice.value ->> 'field'
    FROM collections c, json_each(c.layout, '$.search.filters') choice
    UNION
    SELECT c.id, choice.value ->> 'iconLink'
    FROM collections c, json_each(c.layout, '$.search.filters') choice
    WHERE choice.value ->> 'iconLink' IS NOT NULL`;
  // Read paths only need a few fields from each record when the layout defines the search.
  yield* sql`CREATE VIEW collection_search_projection AS
    SELECT r.collection_id, r.key, (
      SELECT jsonb_group_object(f.field_id, jsonb(r.field_values -> ('$."' || f.field_id || '"')))
      FROM collection_search_fields f WHERE f.collection_id = r.collection_id
    ) AS field_values
    FROM collection_records r
    WHERE EXISTS (SELECT 1 FROM collection_search_fields f WHERE f.collection_id = r.collection_id)`;
  yield* sql`INSERT INTO collection_record_search SELECT * FROM collection_search_projection`;
  yield* sql`CREATE TRIGGER collection_record_search_insert AFTER INSERT ON collection_records
    BEGIN
      INSERT INTO collection_record_search SELECT * FROM collection_search_projection
      WHERE collection_id = NEW.collection_id AND key = NEW.key;
    END`;
  yield* sql`CREATE TRIGGER collection_record_search_update AFTER UPDATE OF field_values ON collection_records
    WHEN NEW.field_values IS NOT OLD.field_values
    BEGIN
      INSERT INTO collection_record_search SELECT * FROM collection_search_projection
      WHERE collection_id = NEW.collection_id AND key = NEW.key
      ON CONFLICT (collection_id, key) DO UPDATE SET field_values = excluded.field_values;
    END`;
  yield* sql`CREATE TRIGGER collection_record_search_layout AFTER UPDATE OF layout ON collections
    WHEN (OLD.layout -> '$.search') IS NOT (NEW.layout -> '$.search')
    BEGIN
      DELETE FROM collection_record_search WHERE collection_id = NEW.id;
      INSERT INTO collection_record_search SELECT * FROM collection_search_projection
      WHERE collection_id = NEW.id;
    END`;
});
