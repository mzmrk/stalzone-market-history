# TODO

## Move price estimation into this repository

Price estimation and auction-cache acquisition currently remain in
`stalzone-artifact-calculator-web`; this repository publishes only raw regional
history archives.

Move the single canonical pricing implementation here, generate and commit
regional price indexes from the published history, and retain the merged index
in Git. Change the calculator to import and bundle that exact index, then remove
its independent auction downloader, cache, and price generator. Both
repositories may contain the generated price data, but only this repository
should own the algorithm.
