# ADR-0009: DOCX Processing Architecture (Split-Run Coalescing), Active PDF Conversion from Day One, and Legacy Removal

- **Date:** 2026-04-20
- **Status:** Proposed

## Context

1. **Split-Run Coalescing in `.docx`:** When a user types a placeholder like `{{ matter.reference | upper }}` in Microsoft Word, Word's spellchecker, grammar checker, and revision-ID (`w:rsidR`) tracker routinely split the text across multiple `<w:r>` (run) and `<w:t>` (text) elements inside a `<w:p>` (paragraph). Our DOCX engine must coalesce split runs reliably, preserve Word formatting, reject macros and zip-bombs, and avoid GPL-licensed libraries.
2. **PDF Conversion Active from Day One:** Users need to generate and download both **Word (`.docx`)** and **PDF (`.pdf`)** documents immediately from day one, without requiring an external cloud container to be provisioned first.
3. **Removal of Legacy Hardcoded Client Care Assembly:** The repository previously contained a hardcoded prototype (`src/domain/documentAssembly.ts` and `src/components/DocumentAssemblyModal.tsx` for `client_care_letter_v1`). To avoid maintaining two parallel document generation implementations, the legacy prototype should be removed and replaced completely by the core Document Generation feature.

## Decision

### 1. DOCX Processing: Deterministic OpenXML ZIP + Paragraph Run-Coalescing Engine

We implement the `basic-merge` DOCX processor in `core/src/domain/document-generation/docxEngine.ts` using Node's built-in `node:zlib` (`inflateRawSync` / `deflateRawSync`) with a strict OpenXML ZIP reader/writer and a dedicated **Paragraph Run-Coalescing Algorithm**:

1. **ZIP & Macro Security Gate:**
   - Verifies local file header magic bytes (`PK\x03\x04`), enforces `maxTemplateSizeMb`, caps total uncompressed size and compression ratio (blocking Zip-Bombs), verifies `[Content_Types].xml`, and **rejects** any archive containing `vbaProject.bin`, `.bin` macro parts, or macro-enabled content types (`.docm`).
2. **WordprocessingML Part Traversal:**
   - Processes `word/document.xml`, all `word/header*.xml`, and all `word/footer*.xml` parts while preserving all other archive entries (styles, fonts, images, relationships).
3. **Paragraph Run-Coalescing Algorithm:**
   - Within each `<w:p>...</w:p>` paragraph (including paragraphs inside table cells `<w:tc>`), extracts the ordered sequence of `<w:r>` runs and `<w:t>` text nodes, ignoring intervening `<w:proofErr/>` and bookmark markers.
   - Locates all `{{ ... }}` and `{% ... %}` spans across the concatenated paragraph text, coalesces split tokens into the first run's `<w:t>` (preserving its `<w:rPr>` bold/italic/font/size/colour properties), and replaces the token with the XML-escaped formatted field value (`xml:space="preserve"`, with `<w:br/>` for multi-line addresses).

### 2. PDF Conversion Active from Day One (`DocumentPdfConverter`)

We define a `DocumentPdfConverter` interface in `core/src/domain/document-generation/pdfConverter.ts` and ship **active PDF conversion from day one** via two adapters:

1. **Built-in OpenXML-to-PDF Layout Renderer (`BuiltInOpenXmlPdfConverter`, active by default):**
   - Runs in-process in TypeScript/Node with zero external container dependencies.
   - Parses the merged `.docx` WordprocessingML AST (headers, footers, headings, paragraphs, bold/italic run styles, bullet/numbered lists, and `<w:tbl>` tables with borders and column widths) and renders a multi-page PDF 1.4 document with word wrapping, typography (Helvetica / Helvetica-Bold / Helvetica-Oblique), table grids, and page numbers (`Page X of Y`).
   - Enables users to select `.docx` or `.pdf` at generation time (`allowUserFormatOverride: true` by default) or set `defaultOutputFormat: 'pdf' | 'docx'` per tenant from day one.
2. **Optional Containerised LibreOffice Headless Adapter (`LibreOfficeHttpPdfConverter`):**
   - For production cloud environments requiring pixel-identical rendering of complex floating graphics or custom embedded fonts, `core/infra/main.bicep` includes the optional `aca-doc-converter` Azure Container App (`enablePdfConverter` parameter), which `DocumentPdfConverter` delegates to when `DOC_CONVERTER_URL` is configured.

### 3. Removal of Legacy `src/domain/documentAssembly.ts` and `src/components/DocumentAssemblyModal.tsx`

- `src/domain/documentAssembly.ts` and `src/components/DocumentAssemblyModal.tsx` are **removed** in Phase 2 (PR 6), and all references in `src/components/MatterProfileClient.tsx` are replaced with the new core Document Generation modal (`DocumentGenerationModal.tsx`) and Saved Documents list (`DocumentListSection.tsx`).
- For demo/seeded tenants (`Pembroke Vaughan` / `Not A Law Firm LLP`), the seed store will include a pre-seeded, approved **Client Care & Engagement Letter** `.docx` template mapped to canonical Field Catalogue keys so users immediately have a working template in the new system.

## Consequences

- Both `.docx` and `.pdf` generation work out of the box from day one in local and cloud environments.
- Legacy hardcoded `client_care_letter_v1` code is cleanly retired in favour of the single tenant-scoped Document Generation architecture.
