import { GitHubLogoIcon } from '@radix-ui/react-icons';
import { toGeoJSON } from 'app/lib/export_pipeline';
import { validateFeatureCollection } from 'app/lib/validation_engine';
import { useAtomValue, useSetAtom } from 'jotai';
import { memo, useCallback, useRef, type ChangeEvent } from 'react';
import toast from 'react-hot-toast';
import {
  activePdfAtom,
  activePdfPageAtom,
  digitizerModeAtom
} from 'state/digitizer';
import { digitizerFeaturesAtom } from 'state/digitizer_features';

export const MenuBar = memo(function MenuBar() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activePdf = useAtomValue(activePdfAtom);
  const setActivePdf = useSetAtom(activePdfAtom);
  const setActivePdfPage = useSetAtom(activePdfPageAtom);
  const digitizerMode = useAtomValue(digitizerModeAtom);
  const setDigitizerMode = useSetAtom(digitizerModeAtom);
  const digitizerFeatures = useAtomValue(digitizerFeaturesAtom);

  const onOpenPdf = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onPdfSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      if (file.type !== 'application/pdf') {
        toast.error('Please select a PDF file');
        event.target.value = '';
        return;
      }

      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();

        const bytes = await file.arrayBuffer();
        const task = pdfjs.getDocument({ data: bytes });
        const doc = await task.promise;

        setActivePdf({
          file,
          pageCount: doc.numPages
        });
        setActivePdfPage(1);
        await task.destroy();

        toast.success(`Loaded PDF: ${file.name}`);
      } catch (_error) {
        toast.error('Could not open PDF');
      } finally {
        event.target.value = '';
      }
    },
    [setActivePdf, setActivePdfPage]
  );

  const onExportZoningGeoJson = useCallback(() => {
    if (!digitizerFeatures.length) {
      toast.error('No digitizer features available to export');
      return;
    }

    const validationResults = validateFeatureCollection(digitizerFeatures);
    const blockingErrors = validationResults.filter(
      (result) => result.severity === 'error'
    );

    if (blockingErrors.length > 0) {
      toast.error(`Export blocked by ${blockingErrors.length} validation errors`);
      return;
    }

    const sourceName = activePdf?.file.name || 'digitizer-session.pdf';
    const featureCollection = toGeoJSON(digitizerFeatures, sourceName);
    const blob = new Blob([JSON.stringify(featureCollection, null, 2)], {
      type: 'application/geo+json'
    });

    const a = document.createElement('a');
    a.download = `zoning-export-${new Date().toISOString().slice(0, 10)}.geojson`;
    a.href = URL.createObjectURL(blob);
    a.addEventListener('click', () => {
      setTimeout(() => URL.revokeObjectURL(a.href), 30 * 1000);
    });
    a.click();

    toast.success('Zoning GeoJSON exported');
  }, [activePdf?.file.name, digitizerFeatures]);

  return (
    <div className="text-white bg-mb-gray-dark font-sans px-3 flex">
      <div className="font-extrabold flex items-center tracking-wide text-base">
        geojson.io
      </div>
      <div className="flex-grow flex justify-between items-center">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDigitizerMode((value) => !value)}
            className="text-xs px-3 py-1 rounded border border-gray-600 hover:border-gray-400"
          >
            {digitizerMode ? 'Exit Digitizer' : 'Open Digitizer'}
          </button>
          <button
            type="button"
            onClick={onOpenPdf}
            className="text-xs px-3 py-1 rounded border border-gray-600 hover:border-gray-400"
          >
            Open PDF
          </button>
          <button
            type="button"
            onClick={onExportZoningGeoJson}
            className="text-xs px-3 py-1 rounded border border-gray-600 hover:border-gray-400"
          >
            Export Zoning GeoJSON
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            onChange={onPdfSelected}
            className="hidden"
          />
        </div>
        <div className="h-[42px]"></div>
        <div className="flex items-center tailwind text-xs text-[10px]">
          powered by
          <div className="pr-3">
            <div
              className="bg-no-repeat bg-center ml-2 h-[18px] w-[76px]"
              style={{ backgroundImage: mapboxLogoDataUrl }}
            />
          </div>
          <div className="flex pl-3 md:px-3 border-l border-solid border-gray-700 h-full items-center">
            ️
            <a
              href="https://github.com/mapbox/geojson.io"
              target="_blank"
              rel="noopener noreferrer"
            >
              <button className="block color-white flex cursor-pointer color-gray-lighter-on-hover">
                <GitHubLogoIcon width={18} height={18} />
              </button>
            </a>
          </div>
          <div className="hidden md:flex pl-3 border-l border-solid border-gray-700 h-full items-center">
            <a
              className="bg-mb-blue-500 hover:bg-mb-blue-700 hover:text-white text-white text-xs font-bold py-1 px-4 rounded transition-all duration-200"
              href="https://account.mapbox.com/auth/signup/"
            >
              Sign up for Mapbox
            </a>
          </div>
        </div>
      </div>
    </div>
  );
});

const mapboxLogoDataUrl =
  'url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA3OTAgMTgwIj48cGF0aCBkPSJNODkuMSAxLjhDMzkuOSAxLjggMCA0MS43IDAgOTAuOSAwIDE0MC4xIDM5LjkgMTgwIDg5LjEgMTgwYzQ5LjIgMCA4OS4xLTM5LjkgODkuMS04OS4xIDAtNDkuMi0zOS45LTg5LjEtODkuMS04OS4xem00NTcuOCAxOS43Yy0xLjIgMC0yLjIgMS0yLjIgMi4ydjEwMy4yYzAgMS4yIDEgMi4yIDIuMiAyLjJoMTMuNGMxLjIgMCAyLjItMSAyLjItMi4ydi03LjFjNi45IDcuMiAxNi40IDExLjMgMjYuMyAxMS4zIDIwLjkgMCAzNy45LTE4IDM3LjktNDAuMyAwLTIyLjMtMTctNDAuMi0zNy45LTQwLjItMTAgMC0xOS41IDQuMS0yNi4zIDExLjNWMjMuN2MwLTEuMi0xLTIuMi0yLjItMi4yaC0xMy40ek05OC4zIDM2LjRjMTEuNC4zIDIyLjkgNC44IDMxLjcgMTMuNyAxNy43IDE3LjcgMTguMyA0NS43IDEuNCA2Mi43LTMwLjUgMzAuNS04NC44IDIwLjctODQuOCAyMC43cy05LjgtNTQuMyAyMC43LTg0LjhjOC41LTguNCAxOS43LTEyLjUgMzEtMTIuM3ptMTYwLjMgMTQuMmMtOC4yIDAtMTUuOSA0LTIwLjggMTAuNnYtNi40YzAtMS4yLTEtMi4yLTIuMi0yLjJoLTEzLjRjLTEuMiAwLTIuMiAxLTIuMiAyLjJWMTI3YzAgMS4yIDEgMi4yIDIuMiAyLjJoMTMuNGMxLjIgMCAyLjItMSAyLjItMi4yVjgzLjhjLjUtOS43IDcuMi0xNy4zIDE1LjQtMTcuMyA4LjUgMCAxNS42IDcuMSAxNS42IDE2LjV2NDRjMCAxLjIgMSAyLjIgMi4yIDIuMmgxMy41YzEuMiAwIDIuMi0xIDIuMi0yLjJsLS4xLTQ0LjljMS4yLTguOCA3LjYtMTUuNiAxNS4zLTE1LjYgOC41IDAgMTUuNiA3LjEgMTUuNiAxNi41djQ0YzAgMS4yIDEgMi4yIDIuMiAyLjJoMTMuNWMxLjIgMCAyLjItMSAyLjItMi4ybC0uMS00OS42Yy4zLTE0LjgtMTIuMy0yNi44LTI3LjktMjYuOC0xMCAuMS0xOS4yIDUuOS0yMy41IDE1LTUtOS4zLTE0LjctMTUuMS0yNS4zLTE1em0xMjcuOSAwYy0yMC45IDAtMzcuOSAxOC0zNy45IDQwLjMgMCAyMi4zIDE3IDQwLjMgMzcuOSA0MC4zIDEwIDAgMTkuNS00LjEgMjYuMy0xMS4zdjcuMWMwIDEuMiAxIDIuMiAyLjIgMi4yaDEzLjRjMS4yIDAgMi4yLTEgMi4yLTIuMlY1NC44Yy4xLTEuMi0uOS0yLjItMi4yLTIuMkg0MTVjLTEuMiAwLTIuMiAxLTIuMiAyLjJ2Ny4xYy02LjktNy4yLTE2LjQtMTEuMy0yNi4zLTExLjN6bTEwNi4xIDBjLTEwIDAtMTkuNSA0LjEtMjYuMyAxMS4zdi03LjFjMC0xLjItMS0yLjItMi4yLTIuMmgtMTMuNGMtMS4yIDAtMi4yIDEtMi4yIDIuMlYxNThjMCAxLjIgMSAyLjIgMi4yIDIuMmgxMy40YzEuMiAwIDIuMi0xIDIuMi0yLjJ2LTM4LjJjNi45IDcuMiAxNi40IDExLjMgMjYuMyAxMS4zIDIwLjkgMCAzNy45LTE4IDM3LjktNDAuMyAwLTIyLjMtMTctNDAuMi0zNy45LTQwLjJ6bTE4NS41IDBjLTIyLjcgMC00MSAxOC00MSA0MC4zIDAgMjIuMyAxOC40IDQwLjMgNDEgNDAuM3M0MS0xOCA0MS00MC4zYzAtMjIuMy0xOC4zLTQwLjMtNDEtNDAuM3ptNDUuNCAyYy0xLjEgMC0yIC45LTIgMiAwIC40LjEuOC4zIDEuMWwyMyAzNS0yMy4zIDM1LjRjLS42LjktLjQgMi4yLjYgMi44LjMuMi43LjMgMS4xLjNoMTUuNWMxLjIgMCAyLjMtLjYgMi45LTEuNmwxMy44LTIzLjEgMTMuOCAyMy4xYy42IDEgMS43IDEuNiAyLjkgMS42aDE1LjVjMS4xIDAgMi0uOSAyLTIgMC0uNC0uMS0uNy0uMy0xLjFMNzY2IDkwLjdsMjMtMzVjLjYtLjkuNC0yLjItLjYtMi44LS4zLS4yLS43LS4zLTEuMS0uM2gtMTUuNWMtMS4yIDAtMi4zLjYtMi45IDEuNmwtMTMuNSAyMi43LTEzLjUtMjIuN2MtLjYtMS0xLjctMS42LTIuOS0xLjZoLTE1LjV6TTk5LjMgNTRsLTguNyAxOC0xNy45IDguNyAxNy45IDguNyA4LjcgMTggOC44LTE4IDE3LjktOC43LTE3LjktOC43LTguOC0xOHptMjkwLjMgMTIuN2MxMi43IDAgMjMgMTAuNyAyMy4yIDIzLjl2LjZjLS4xIDEzLjItMTAuNSAyMy45LTIzLjIgMjMuOS0xMi44IDAtMjMuMi0xMC44LTIzLjItMjQuMiAwLTEzLjQgMTAuNC0yNC4yIDIzLjItMjQuMnptOTkuOCAwYzEyLjggMCAyMy4yIDEwLjggMjMuMiAyNC4yIDAgMTMuNC0xMC40IDI0LjItMjMuMiAyNC4yLTEyLjcgMC0yMy0xMC43LTIzLjItMjMuOXYtLjZjLjItMTMuMiAxMC41LTIzLjkgMjMuMi0yMy45em05Ni4zIDBjMTIuOCAwIDIzLjIgMTAuOCAyMy4yIDI0LjIgMCAxMy40LTEwLjQgMjQuMi0yMy4yIDI0LjItMTIuNyAwLTIzLTEwLjctMjMuMi0yMy45di0uNmMuMi0xMy4yIDEwLjUtMjMuOSAyMy4yLTIzLjl6bTkyLjIgMGMxMi44IDAgMjMuMiAxMC44IDIzLjIgMjQuMiAwIDEzLjQtMTAuNCAyNC4yLTIzLjIgMjQuMi0xMi44IDAtMjMuMi0xMC44LTIzLjItMjQuMiAwLTEzLjQgMTAuNC0yNC4yIDIzLjItMjQuMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=)';
