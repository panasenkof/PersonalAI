# 41 deterministic image examples for PersAI Vision Lab

The canonical dataset lives in [cases.json](cases.json); recreate raster JPGs
by running `python generate.py <output-dir>` with **Pillow 11.3.0**.

**These are synthetic, programmatically drawn illustrations, NOT photographs
or generated evidence of real-world image-search quality.** All JPEGs omit
captions/overlays so the model cannot cheat by reading a label. The labeling
in `cases.json` is an expected *human intent* (positive, hard negative,
negative, or reference) and never asserts a model score.

The 8 groups contain **41 separate JPEG files** (640×440) across:
red bicycles / different objects by trees, cars by homes, pets on furniture,
flowers in vases, pasta/salads, mountain landscapes, cups and household items,
and a dedicated one-reference-plus-five-candidate **photo→photo** set.

## User procedure on Android 16

1. Go to the latest passing pull-request **Vision SDK compile spike (isolated)**
   GitHub Actions run. Under **Artifacts** download
   `persai-vision-41-labeled-jpegs`. Unzip the outer GitHub artifact and then
   `PersAI_Vision_41_cases.zip` to obtain individual `images/*.jpg`,
   `cases.json` and `README_RU.txt`. All 41 images are available without
   using ChatGPT sandbox links or Library.
2. Install the separately signed **PersAI Vision Lab 0.1.5** APK from the
   `persai-vision-lab-android16-image-to-image` artifact in the same run,
   removing *only* the older Vision Lab if signing mismatch occurs.
   **Never remove the main PersAI**. Select the same pre-downloaded model.
3. For text→photo, enter `Красный велосипед рядом с деревом`, select
   `bike_red_tree`, `bike_red_bench`, `bike_blue_tree`,
   `bike_red_motorcycle` and `bike_tree_only` in any **known** order
   using step 4, then tap step 5. Inspect ranking/latency, not scores as
   probabilities.
4. For photo→photo, clear the candidate set. Using step 6
   **«Выбрать фото-образец»** choose `ref_bike_A.jpg`. Using step 4
   **«Добавить фото в тестовый набор»** select in order
   `candidate_bike_A_angle`, `candidate_bike_B`,
   `candidate_blue_bike`, `candidate_red_scooter`,
   `candidate_tree_bench`. Tap step 7 **«Найти похожие фото»**.
   Candidate A is *designed* as the closest illustration of the same red
   bicycle; near-same-color other bikes are **hard negatives**.
5. Send the visible order and elapsed time, not the actual personal photos.
   A correct-looking result on these synthetic images is a **smoke test**.
   Real-family/vehicle/office photos, 10–20+ hand-labeled queries,
   photo→photo identity-vs-similarity tests and peak RAM require a separate
   real-data evaluation before any 83.2 production rollout.

## Architecture/test guarantees

- The generator and explicit labels are **committed to GitHub**, so anyone
  can rebuild identical samples even after 14-day GitHub Actions artifacts
  expire. Build does not require any model weights and does not embed
  reference images into the production application.
- The `test_cases.py` fixture suite checks ID uniqueness, positive/negative
  labels, anchor/candidate separation, generation of valid individual JPEG
  files and source reproducibility. The app's JVM tests also cover ranking
  stability, NaNs and 2–5 limits; model quality **is not faked by unit tests**.
- Neither the synthetic bundle nor the Vision Lab app requires Internet
  permission at runtime. The images are never stored in the main PersAI
  SQLCipher memory, and no additional search index/writer is introduced.
