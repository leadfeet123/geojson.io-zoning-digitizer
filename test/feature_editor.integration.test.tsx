// @vitest-environment jsdom

import { FeatureEditor } from 'app/components/feature_editor/FeatureEditor';
import type { DigitizerFeature } from 'types/digitizer';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { suggestPlanningClassMock } = vi.hoisted(() => ({
  suggestPlanningClassMock: vi.fn()
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('app/lib/classification_adapter', () => ({
  defaultClassificationAdapter: {
    suggestPlanningClass: suggestPlanningClassMock
  }
}));

function makeFeature(
  overrides: Partial<DigitizerFeature> = {}
): DigitizerFeature {
  return {
    id: 'feature-1',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-122.5, 37.7],
          [-122.4, 37.7],
          [-122.4, 37.8],
          [-122.5, 37.8],
          [-122.5, 37.7]
        ]
      ]
    },
    properties: {
      planning_class: '',
      raw_zoning_label: 'C-2',
      confidence: 0.2,
      source_type: 'digitized',
      source_name: 'example.pdf',
      human_confirmed: false
    },
    ...overrides
  };
}

describe('FeatureEditor integration', () => {
  let container: HTMLDivElement;

  afterEach(() => {
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    suggestPlanningClassMock.mockReset();
  });

  it('runs suggest -> accept workflow and persists ai suggestion decision', async () => {
    const feature = makeFeature();
    const onFeatureChange = vi.fn();

    suggestPlanningClassMock.mockResolvedValue([
      {
        planning_class: 'Commercial',
        confidence: 0.81,
        rationale: 'Municipal code mapping'
      }
    ]);

    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <FeatureEditor
          selectedFeature={feature}
          validationResults={[]}
          onFeatureChange={onFeatureChange}
        />
      );
    });

    const municipalityInput = container.querySelector(
      'input[placeholder="e.g., San Jose, CA"]'
    ) as HTMLInputElement | null;
    expect(municipalityInput).not.toBeNull();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setValue?.call(municipalityInput, 'San Jose');
      municipalityInput!.dispatchEvent(new Event('input', { bubbles: true }));
      municipalityInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const suggestButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Suggest Planning Class')
    ) as HTMLButtonElement | undefined;

    expect(suggestButton).toBeDefined();

    await act(async () => {
      suggestButton!.click();
    });

    expect(suggestPlanningClassMock).toHaveBeenCalledWith({
      rawZoningLabel: 'C-2',
      municipality: 'San Jose'
    });

    const acceptButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Accept'
    ) as HTMLButtonElement | undefined;

    expect(acceptButton).toBeDefined();

    await act(async () => {
      acceptButton!.click();
    });

    const lastCallArg = onFeatureChange.mock.calls.at(-1)?.[0] as
      | DigitizerFeature
      | undefined;

    expect(lastCallArg).toBeDefined();
    expect(lastCallArg?.properties.planning_class).toBe('Commercial');
    expect(lastCallArg?.properties.confidence).toBe(0.81);
    expect(lastCallArg?.properties.human_confirmed).toBe(false);
    const suggestion = lastCallArg?.properties.ai_suggestions?.[0];
    expect(suggestion?.field).toBe('planning_class');
    expect(suggestion?.value).toBe('Commercial');
    expect(suggestion?.confidence).toBe(0.81);
    expect(suggestion?.accepted).toBe(true);
    expect(suggestion?.decision_history).toHaveLength(1);
    expect(suggestion?.decision_history?.[0].action).toBe('accepted');

    await act(async () => {
      root.unmount();
    });
  });

  it('supports explicit override for planning-class AI suggestions', async () => {
    const feature = makeFeature({
      properties: {
        planning_class: 'Custom Mixed Use',
        raw_zoning_label: 'C-2',
        confidence: 0.2,
        source_type: 'digitized',
        source_name: 'example.pdf',
        human_confirmed: false
      }
    });
    const onFeatureChange = vi.fn();

    suggestPlanningClassMock.mockResolvedValue([
      {
        planning_class: 'Commercial',
        confidence: 0.81,
        rationale: 'Municipal code mapping'
      }
    ]);

    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <FeatureEditor
          selectedFeature={feature}
          validationResults={[]}
          onFeatureChange={onFeatureChange}
        />
      );
    });

    const suggestButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Suggest Planning Class')
    ) as HTMLButtonElement | undefined;

    expect(suggestButton).toBeDefined();

    await act(async () => {
      suggestButton!.click();
    });

    const overrideButton = Array.from(
      container.querySelectorAll('button')
    ).find((button) => button.textContent?.trim() === 'Override') as
      | HTMLButtonElement
      | undefined;

    expect(overrideButton).toBeDefined();

    await act(async () => {
      overrideButton!.click();
    });

    const lastCallArg = onFeatureChange.mock.calls.at(-1)?.[0] as
      | DigitizerFeature
      | undefined;

    expect(lastCallArg).toBeDefined();
    expect(lastCallArg?.properties.planning_class).toBe('Custom Mixed Use');
    expect(lastCallArg?.properties.human_confirmed).toBe(false);
    const suggestion = lastCallArg?.properties.ai_suggestions?.[0];
    expect(suggestion?.field).toBe('planning_class');
    expect(suggestion?.value).toBe('Commercial');
    expect(suggestion?.accepted).toBe(false);
    expect(suggestion?.decision_history).toHaveLength(1);
    expect(suggestion?.decision_history?.[0].action).toBe('overridden');

    await act(async () => {
      root.unmount();
    });
  });
});
