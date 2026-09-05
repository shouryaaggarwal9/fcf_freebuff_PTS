/**
 * CandlestickChart — lightweight-charts (TradingView) wrapper for the
 * deterministic NSE candle series.
 *
 * Prices arrive as integer paise (bigint) from src/engine and are converted
 * to rupees NUMBERS only at the rendering boundary (pixels/labels need
 * numbers; the engine, ledger and wallet never see a float).
 *
 * Attribution: charting is powered by Lightweight Charts™
 * (https://www.tradingview.com/lightweight-charts/), Apache-2.0.
 */
import type { Candle } from "@/engine/model";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

function toEpochSec(time: Time): number {
  return typeof time === "number" ? time : 0;
}
import { useEffect, useRef } from "react";
import { istTimeFull, istTimeLabel } from "@/lib/format";

const UP = "#2fce8f"; // --up (emerald)
const DOWN = "#ff5d73"; // --down (rose)
const GRID = "rgba(148, 163, 184, 0.07)";
const BORDER = "rgba(148, 163, 184, 0.16)";
const TEXT = "#8fa3bf";
const CROSS = "rgba(148, 163, 184, 0.45)";

function toRupee(paise: bigint): number {
  return Number(paise) / 100;
}

export interface CandleChartProps {
  symbol: string;
  /** Ascending OHLC bars ending at (or containing) the current second. */
  candles: Candle[];
  /** Chart height in px. */
  height?: number;
}

export function CandleChart({ symbol, candles, height = 400 }: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const keyRef = useRef<string>("");
  const pausedRef = useRef(false);

  // Mount the chart once. autoSize keeps it glued to its container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: TEXT,
        fontSize: 11,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: CROSS,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(15, 23, 42, 0.9)",
        },
        horzLine: {
          color: CROSS,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(15, 23, 42, 0.9)",
        },
      },
      rightPriceScale: { borderColor: BORDER },
      timeScale: {
        borderColor: BORDER,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => istTimeLabel(toEpochSec(time)),
      },
      localization: {
        locale: "en-IN",
        timeFormatter: (time: Time) => istTimeFull(toEpochSec(time)),
        priceFormatter: (p: number) =>
          `₹${p.toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`,
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.05 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    pausedRef.current = false;

    const markPaused = () => {
      pausedRef.current = true;
    };
    el.addEventListener("pointerdown", markPaused);
    return () => {
      el.removeEventListener("pointerdown", markPaused);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push candle data. Full setData on every tick is fine for <300 bars.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const data: CandlestickData<UTCTimestamp>[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: toRupee(c.openPaise),
      high: toRupee(c.highPaise),
      low: toRupee(c.lowPaise),
      close: toRupee(c.closePaise),
    }));
    series.setData(data);
    const key = `${symbol}:${data.length}`;
    if (keyRef.current !== key) {
      keyRef.current = key;
      chart.timeScale().fitContent();
      pausedRef.current = false;
    } else if (!pausedRef.current) {
      chart.timeScale().scrollToRealTime();
    }
  }, [candles, symbol]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute right-2 bottom-1 select-none text-right text-[10px] text-muted-foreground/50">
        Charts by TradingView Lightweight Charts™ · Apache-2.0
      </div>
    </div>
  );
}
