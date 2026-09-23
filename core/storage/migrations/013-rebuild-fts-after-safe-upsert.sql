-- Remove stale and duplicate FTS rows left by historical INSERT OR REPLACE
-- writes. FTS tables are derived data, so rebuilding them from their source
-- tables is deterministic and does not discard user-authored records.

DELETE FROM traces_fts;
INSERT INTO traces_fts(trace_id, user_text, agent_text, summary, reflection, tags)
SELECT id,
       user_text,
       agent_text,
       COALESCE(summary, ''),
       COALESCE(reflection, ''),
       tags_json
  FROM traces;

DELETE FROM policies_fts;
INSERT INTO policies_fts(policy_id, title, trigger, procedure, verification, boundary, guidance)
SELECT id,
       title,
       trigger,
       procedure,
       verification,
       boundary,
       COALESCE(decision_guidance_json, '')
  FROM policies;

DELETE FROM skills_fts;
INSERT INTO skills_fts(skill_id, name, invocation_guide)
SELECT id, name, invocation_guide
  FROM skills;

DELETE FROM world_model_fts;
INSERT INTO world_model_fts(world_id, title, body, domain_tags)
SELECT id,
       title,
       body,
       COALESCE(domain_tags_json, '')
  FROM world_model;
