
    WITH q AS (SELECT
      plainto_tsquery('english',$2) || plainto_tsquery('simple',$2) AS exact,
      websearch_to_tsquery('english',$3) || websearch_to_tsquery('simple',$3) AS broad),
    scoped AS MATERIALIZED (SELECT c.*,c.version_id||':'||c.page_number id,0 position,d.id document_id FROM document_text_pages c
      JOIN document_texts d ON d.current_version_id=c.version_id
      WHERE d.owner_id=$1 AND d.hidden=false
      AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
        AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
        AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))),
    terms AS (SELECT term,plainto_tsquery('english',term)||plainto_tsquery('simple',term) query FROM unnest($5::text[]) term),
    collection AS MATERIALIZED (SELECT count(*) n,greatest(1,avg(length(search_vector))) avg_length FROM scoped),
    frequencies AS MATERIALIZED (SELECT t.*, (SELECT count(*) FROM scoped s WHERE s.search_vector @@ t.query) df FROM terms t),
    term_weights AS MATERIALIZED (SELECT f.*,ln(1+(collection.n-f.df+.5)/(f.df+.5)) idf
      FROM frequencies f CROSS JOIN collection WHERE f.df>0),
    scored AS (SELECT c.*,coalesce((SELECT sum(
        f.idf*
        (tf.value*2.2)/(tf.value+1.2*(.25+.75*length(c.search_vector)/collection.avg_length)))
      FROM term_weights f CROSS JOIN LATERAL (SELECT ts_rank_cd(c.search_vector,f.query,0)*10 value) tf
      WHERE c.search_vector @@ f.query AND tf.value>0),0) score,
      coalesce((SELECT sum(f.idf) FROM term_weights f WHERE c.search_vector @@ f.query)/
        nullif((SELECT sum(idf) FROM term_weights),0),0) lexical_support
      FROM scoped c,q,collection WHERE c.search_vector @@ q.broad),
    diverse AS (SELECT *,row_number() OVER (PARTITION BY document_id,page_number ORDER BY score DESC,position) page_rank FROM scored)
    SELECT 'pg:'||coalesce(snippet.id,c.id) AS id,d.id AS document_id,coalesce(d.course_id,'') AS course_id,
      d.name,d.origin,d.origin_key,d.source_hash,coalesce(snippet.body,c.body) body,p.locator,p.page_number,p.content_kind,p.start_ms::double precision,p.end_ms::double precision,
      p.evidence_id,v.source_version_id,v.parser_version,v.warnings AS parser_warnings,c.score,c.lexical_support
    FROM diverse c JOIN document_texts d ON d.id=c.document_id CROSS JOIN q
      JOIN document_text_versions v ON v.id=c.version_id
      JOIN document_text_pages p ON p.version_id=c.version_id AND p.page_number=c.page_number
      LEFT JOIN LATERAL (SELECT chunk.id,chunk.body FROM document_text_chunks chunk
        WHERE chunk.version_id=c.version_id AND chunk.page_number=c.page_number
        ORDER BY ts_rank_cd(chunk.search_vector,q.broad,0) DESC,chunk.position LIMIT 1) snippet ON true
    WHERE c.page_rank=1
    ORDER BY score DESC,d.id,c.position LIMIT $4