// fork(salvare): the tier editor's pricing-mode choice and one-time price field.
import React, { useEffect, useRef, useState } from 'react';
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  RadioGroup,
  RadioGroupItem,
} from '@tryghost/shade/components';
import { Stack } from '@tryghost/shade/primitives';
import {
  ONE_TIME_PRICE_PLACEHOLDER,
  type PricingMode,
  formatOneTimePriceInput,
  parseOneTimePriceInput,
} from './tier-one-time-price';

const modeOptions: { value: PricingMode; label: string }[] = [
  { value: 'subscription', label: 'Subscription' },
  { value: 'one_time', label: 'One-time purchase' },
];

/** Keeps the typed text while emitting cents; an empty field emits `null`. */
const useOneTimePriceInput = (
  cents: number | null | undefined,
  onChange: (cents: number | null) => void,
) => {
  const [value, setValue] = useState(formatOneTimePriceInput(cents));
  const lastEmitted = useRef(cents);

  useEffect(() => {
    if (!Object.is(cents, lastEmitted.current)) {
      setValue(formatOneTimePriceInput(cents));
    }
    lastEmitted.current = cents;
  }, [cents]);

  return {
    value,
    onBlur: () => setValue(formatOneTimePriceInput(parseOneTimePriceInput(value))),
    onChange: (input: string) => {
      const parsed = parseOneTimePriceInput(input);
      setValue(input.replace(/[^\d.]+/g, ''));
      lastEmitted.current = parsed;
      onChange(parsed);
    },
  };
};

const TierPricingMode: React.FC<{
  mode: PricingMode;
  onModeChange: (mode: PricingMode) => void;
  oneTimePrice: number | null | undefined;
  onOneTimePriceChange: (cents: number | null) => void;
  currency: string | undefined;
  error?: string;
  onClearError: () => void;
}> = ({
  mode,
  onModeChange,
  oneTimePrice,
  onOneTimePriceChange,
  currency,
  error,
  onClearError,
}) => {
  const priceInput = useOneTimePriceInput(oneTimePrice, onOneTimePriceChange);

  return (
    <Stack className="mt-2 mb-4" gap="md">
      <FieldSet>
        <FieldLegend variant="label">Pricing</FieldLegend>
        <RadioGroup
          aria-label="Pricing"
          value={mode}
          onValueChange={(value) => onModeChange(value as PricingMode)}
        >
          {modeOptions.map((option) => {
            const id = `tier-pricing-mode-${option.value}`;
            return (
              <Field key={option.value} orientation="horizontal">
                <RadioGroupItem id={id} value={option.value} />
                <FieldLabel className="cursor-pointer" htmlFor={id}>
                  {option.label}
                </FieldLabel>
              </Field>
            );
          })}
        </RadioGroup>
      </FieldSet>
      {mode === 'one_time' && (
        <Field data-invalid={Boolean(error) || undefined}>
          <FieldLabel className="sr-only" htmlFor="tier-one-time-price">
            One-time price
          </FieldLabel>
          <InputGroup data-invalid={Boolean(error) || undefined}>
            <InputGroupInput
              aria-invalid={Boolean(error) || undefined}
              id="tier-one-time-price"
              inputMode="decimal"
              placeholder={formatOneTimePriceInput(ONE_TIME_PRICE_PLACEHOLDER)}
              value={priceInput.value}
              onBlur={priceInput.onBlur}
              onChange={(event) => priceInput.onChange(event.target.value)}
              onKeyDown={onClearError}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{currency}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      )}
    </Stack>
  );
};

export default TierPricingMode;
