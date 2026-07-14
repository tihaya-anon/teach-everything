# Confirm cancellation before marking runs cancelled

A client stream abort requests cancellation of the interactive Agent Run, and the API propagates that request to the graph, model, and tools. The run is recorded as `cancelled` only after cancellation is confirmed; if work cannot be stopped, it is recorded as `failed` with the `cancellation_failed` classification, and the first version does not silently detach continuing work.
