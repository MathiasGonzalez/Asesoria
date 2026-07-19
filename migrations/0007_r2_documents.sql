-- Persistent file storage metadata for tax documents uploaded to R2.
-- source: 'paste' (manual text), 'upload' (file via R2), 'gdoc' (Google Docs import)

ALTER TABLE tax_documents ADD COLUMN r2_key     TEXT;
ALTER TABLE tax_documents ADD COLUMN mime_type  TEXT;
ALTER TABLE tax_documents ADD COLUMN file_size  INTEGER;
ALTER TABLE tax_documents ADD COLUMN source     TEXT NOT NULL DEFAULT 'paste';
ALTER TABLE tax_documents ADD COLUMN source_url TEXT;
