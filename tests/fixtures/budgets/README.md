# Synthetic Feature 005 fixtures

All documents are generated locally as blank synthetic pages, without client data,
attachments, scripts or external resources. Encryption is deliberately obsolete
PDF Standard Security Handler R2/40-bit RC4 **for test fixtures only**, never for
application use. Public synthetic passwords are fixture-user-only and
fixture-owner-only. These are not operational credentials.

Generator: /home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/fixtures/budgets/build-fixtures.js.
The generator writes only the eight small documents and manifest in its own folder.
Boundary PDFs (10 MiB minus one byte, exactly 10 MiB and plus one byte) are generated
in memory via buildPdf({ size }) to avoid committing 30 MiB of padding.

**qpdf verification completed in the API image: qpdf 12.3.2 (APK 12.3.2-r0).**
`qpdf-observed.json` records the actual image ID, effective UID, SHA-256, stdout,
stderr and exits of both commands, including the three generated boundaries.
`manifest.json` retains independent expectations and references that evidence.
The generator validates recorded evidence before incorporating it; it never
changes expectations to match an observation. Byte generation does not use qpdf.

Rebuild instructions and isolated read-only verification are in
/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/specs/005-budgets-pdf/quickstart.md.
The explicit verifier is
/home/wpossidonio/Documentos/Freelancer/Back-end/api-alves-glass-clone-feature005/tests/support/budgets/verify-qpdf-fixtures.js.
It runs sequentially without shell, with 10-second timeout, bounded output and
private temporary files cleaned in finally. Missing binaries fail closed.

All eight original expectations matched. No bytes or classifications were changed.
Only plain and empty-password have check=0 and password status in [2,3].
The renamed non-PDF remains unsupportedMediaType by the future header policy;
qpdf itself only establishes rejection, not the HTTP error classification.
The +1 boundary is structurally valid but must be rejected by the future upload
size guard. No upload endpoint or production validator is implemented here.
Xref assertions and qpdf do not establish that documents are malware-free.
