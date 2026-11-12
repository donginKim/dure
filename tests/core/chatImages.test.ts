import { cleanImages } from '@core/workspaceService';

test('붙인 이미지는 종류, 수, 크기를 확인한다. 어긋나면 조용히 빼지 않고 던진다', () => {
  expect(cleanImages(undefined)).toEqual([]);
  expect(cleanImages([{ mediaType: 'image/png', data: 'AAAA', extra: 1 }])).toEqual([{ mediaType: 'image/png', data: 'AAAA' }]);
  expect(() => cleanImages('x')).toThrow('올바르지 않습니다');
  expect(() => cleanImages([{ mediaType: 'image/svg+xml', data: 'AAAA' }])).toThrow('PNG, JPEG, GIF, WebP');
  expect(() => cleanImages([{ mediaType: 'image/png', data: 'not base64!' }])).toThrow('올바르지 않습니다');
  expect(() => cleanImages([{ mediaType: 'image/png', data: '' }])).toThrow('올바르지 않습니다');
  expect(() => cleanImages(Array.from({ length: 6 }, () => ({ mediaType: 'image/png', data: 'AAAA' })))).toThrow('5장까지');
  expect(() => cleanImages([{ mediaType: 'image/png', data: 'A'.repeat(7 * 1024 * 1024) }])).toThrow('너무 큽니다');
});
