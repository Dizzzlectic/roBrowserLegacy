import { describe, expect, it, vi } from 'vitest';
import { loadItemPackages, normalizeItemPackages } from 'DB/Items/ItemPackages.js';

describe('selection package metadata', () => {
	it('keeps zero-based group IDs and all rewards, including refinement', () => {
		const packages = normalizeItemPackages({
			names: [[101454, 0, 'Sword'], [101454, 10, 'Foxtail']],
			items: [[101454, 0, 21005, 1, 0, 7, 0], [101454, 10, 26111, 1, 0, 7, 0], [101454, 10, 501, 3, 24, 0, 1]]
		});
		expect(packages.get(101454)).toEqual([
			{ id: 0, name: 'Sword', items: [{ id: 21005, amount: 1, hours: 0, refine: 7, randomOption: false, grade: 0 }] },
			{ id: 10, name: 'Foxtail', items: [
				{ id: 26111, amount: 1, hours: 0, refine: 7, randomOption: false, grade: 0 },
				{ id: 501, amount: 3, hours: 24, refine: 0, randomOption: true, grade: 0 }
			] }
		]);
	});

});

describe('optional package file loading', () => {
	it('finishes when neither Lua alias exists', async () => {
		const requested = [];
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const packages = await loadItemPackages({}, 'data/', 20221005, (path, _done, fail) => {
				requested.push(path);
				fail(new Error('Missing file'));
			}, value => value);
			expect(packages.size).toBe(0);
			expect(requested).toEqual(['data/selectpackage/selectpackageitem.lub', 'data/selectpackage/selectpackageitem.lua']);
		} finally {
			warning.mockRestore();
		}
	});

	it('tries the text alias after an unreadable compiled file and unmounts both', async () => {
		const unmounted = [];
		const lua = {
			ctx: {}, mountFile() {}, unmountFile: path => unmounted.push(path),
			async doFile(path) {
				if (path.endsWith('.lub')) {
					throw new Error('Unsupported bytecode');
				}
			},
			doStringSync(source) {
				// Emulate the Lua bridge's output; table syntax is exercised separately with real Lua.
				if (source.includes('if SelectPackageItemData then')) {
					this.ctx.roPackageName(101454, 0, 'Sword');
					this.ctx.roPackageItem(101454, 0, 21005, 1, 0, 7, 0, 0);
				}
			}
		};
		const packages = await loadItemPackages(lua, 'data/', 20221005, (_path, done) => done(new ArrayBuffer(1)), value => value);
		expect(packages.get(101454)[0]).toMatchObject({ id: 0, name: 'Sword', items: [{ id: 21005, refine: 7 }] });
		expect(unmounted.sort()).toEqual(['data/selectpackage/selectpackageitem.lua', 'data/selectpackage/selectpackageitem.lub']);
	});
});


describe('supplementary package metadata', () => {
	const supplement = 'data/selectpackage/supplement.lua';
	// Model only the file/Lua boundary; parsing real client files is checked in integration.
	function loader(files) {
		let rows;
		const lua = {
			ctx: {}, mountFile() {}, unmountFile() {},
			async doFile(path) {
				rows = files[path];
				if (rows instanceof Error) throw rows;
			},
			doStringSync(source) {
				if (source.includes('if SelectPackageItemData then')) {
					for (const row of rows) this.ctx.roPackageItem(...row);
				}
			}
		};
		return loadItemPackages(lua, 'data/', 20221005, (path, done, fail) => {
			if (path in files) done(new Uint8Array());
			else fail(new Error('Missing file'));
		}, value => value, supplement);
	}

	it('adds absent boxes without replacing or extending any native box', async () => {
		const packages = await loader({
			'data/selectpackage/selectpackageitem.lub': [[100, 0, 501, 2, 0, 0, 0, 0]],
			[supplement]: [[100, 0, 502, 9, 0, 0, 0, 0], [100, 1, 503, 1, 0, 0, 0, 0],
				[200, 7, 21005, 1, 0, 7, 0, 0]]
		});
		expect(packages.get(100)).toEqual([{ id: 0, name: '', items: [
			{ id: 501, amount: 2, hours: 0, refine: 0, randomOption: false, grade: 0 }
		] }]);
		expect(packages.get(200)).toEqual([{ id: 7, name: '', items: [
			{ id: 21005, amount: 1, hours: 0, refine: 7, randomOption: false, grade: 0 }
		] }]);
	});

	it('loads the supplement even when native aliases are absent', async () => {
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const packages = await loader({ [supplement]: [[200, 0, 501, 1, 0, 0, 0, 0]] });
			expect(packages.get(200)[0].id).toBe(0);
		} finally { warning.mockRestore(); }
	});

	it('retains native choices when the optional supplement is missing or unreadable', async () => {
		const native = { 'data/selectpackage/selectpackageitem.lub': [[100, 0, 501, 2, 0, 0, 0, 0]] };
		const missing = await loader(native);
		const unreadable = await loader({ ...native, [supplement]: new Error('Invalid Lua') });
		expect([...missing.keys()]).toEqual([100]);
		expect(unreadable).toEqual(missing);
	});
});
