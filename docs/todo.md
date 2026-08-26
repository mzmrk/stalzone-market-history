# TODO

## Finish price-estimation migration

The canonical estimator, API findings, and current merged price index now live
here. The remaining integration work is to generate regional indexes from the
validated release archives after collection, merge them without discarding
unchanged regions, and commit the merged index with the workflow status.

After that, change the calculator to synchronize and bundle this exact index,
then remove its independent auction downloader, cache, and estimator. Both
repositories may contain generated price data, but only this repository owns
the algorithm.
