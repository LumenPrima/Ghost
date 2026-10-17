// fork(salvare)
import { tier } from '@tryghost/test-data';
import { getTiersCadences } from './get-tiers-cadences';

describe('getTiersCadences', () => {
  it('leaves out purchase-only tiers, which offers cannot target', () => {
    const supporter = tier({ id: 'supporter', name: 'Supporter', currency: 'usd' });
    const course = tier({ id: 'course', name: 'Course', currency: 'usd', one_time_price: 9900 });

    expect(getTiersCadences([supporter, course])).toEqual([
      { label: 'Supporter - Monthly', value: 'supporter-month-usd' },
      { label: 'Supporter - Yearly', value: 'supporter-year-usd' },
    ]);
  });
});
