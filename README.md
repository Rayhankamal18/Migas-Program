# Migas Program

Browser-based petroleum and well-data toolkit: azimuth/inclination charts, casing setting depth, drilling summary, boxplots, AI suggestions, AutoML, and Graph Grabber.

## Features

- Azimuth & inclination polar charts
- Casing setting depth and formations
- Drilling time vs depth summary
- Box-and-whisker plots
- AutoML: train saved models from CSV
- **Memory-safe CSV predictions:** CSV rows are predicted one at a time with live percentage and exact failed-row errors. Large files do not become one huge prediction request.
- **Graph Grabber:** upload a chart image, enter axis values, tap/click X1 → X2 → Y1 → Y2 to calibrate. Blue axis lines show calibration. Tap/click curve points to see live X/Y table. Export `point,x,y` CSV.
- Graph Grabber supports mouse-wheel or slider zoom, drag-to-pan, Fit reset, desktop and phone touch controls.

## Run

### Windows

Run `Start_Migas.bat`.

### Linux / VPS

```bash
python3 launcher.py
```

Open the URL shown by the launcher. For the AutoML backend, use the project server entrypoint under `server/` as described in `SETUP_VPS.md`.

## Graph Grabber workflow

1. Open **Graph Grabber**.
2. Upload a graph image.
3. Enter X1, X2, Y1, Y2 numeric values.
4. Click/tap each corresponding location on the image in that order.
5. Drag to pan. Zoom using mouse wheel or slider.
6. Click/tap curve locations. The X/Y table updates immediately.
7. Download CSV.

## AutoML CSV prediction

Choose **Predict from CSV** in AutoML. The UI processes and reports each row as it completes. If one row fails, the UI reports its 1-based row number and stops, preserving clear diagnosis rather than exhausting memory.

## Structure

- `automl/` — AutoML UI
- `server/` — Flask and model workers
- `grabber/` — browser graph digitizer
- `azimuth/`, `casing/`, `drilling/`, `boxplot/`, `ai/` — feature modules
- `shared/` — common assets

## Upstream

Forked from [Rayhankamal18/Migas-Program](https://github.com/Rayhankamal18/Migas-Program).

## License

See upstream repository license.
