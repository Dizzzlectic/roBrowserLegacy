/** Normalize client package tables without changing the server's zero-based group IDs. */
export function normalizeItemPackages({ names = [], items = [] } = {}) {
	const packages = new Map();
	const labels = new Map();
	for (const [box, group, name] of Object.values(names)) {
		labels.set(`${box}:${group}`, name);
	}
	const add = (box, group, item, name) => {
		box = Number(box);
		group = Number(group);
		if (
			!Number.isInteger(box) ||
			box <= 0 ||
			!Number.isInteger(group) ||
			group < 0 ||
			!Number.isInteger(item.id) ||
			item.id <= 0 ||
			!Number.isInteger(item.amount) ||
			item.amount <= 0
		) {
			return;
		}
		if (!packages.has(box)) {
			packages.set(box, new Map());
		}
		const groups = packages.get(box);
		if (!groups.has(group)) {
			groups.set(group, { id: group, name: name || '', items: [] });
		}
		groups.get(group).items.push(item);
	};
	for (const [box, group, id, amount, hours = 0, refine = 0, randomOption = 0, grade = 0] of Object.values(items)) {
		add(
			box,
			group,
			{ id, amount, hours, refine, randomOption: Boolean(randomOption), grade },
			labels.get(`${box}:${group}`)
		);
	}
	return new Map([...packages].map(([box, groups]) => [box, [...groups.values()].sort((a, b) => a.id - b.id)]));
}

/** Read both Lua formats through the same bridge; compiled .lub files work too. */
export function readItemPackages(lua, decode) {
	const names = [];
	const items = [];
	lua.ctx.roPackageName = (box, group, name) => names.push([box, group, decode(name)]);
	lua.ctx.roPackageItem = (box, group, id, amount, hours, refine, randomOption, grade) =>
		items.push([box, group, id, amount, hours, refine, randomOption, grade]);
	lua.doStringSync(`
		if SelectPackageItemData then
			for box, groups in pairs(SelectPackageItemData.TabNameTbl or {}) do
				for group, name in pairs(groups) do roPackageName(box, group, name) end
			end
			for box, groups in pairs(SelectPackageItemData.PackageTbl or {}) do
				for group, rewards in pairs(groups) do
					for _, item in pairs(rewards) do
						roPackageItem(box, group, item.item, item.cnt, item.hour or 0,
							item.refine or 0, item.randomOption and 1 or 0, item.grade or 0)
					end
				end
			end
		else
			for _, row in pairs(packageitemboxName or {}) do roPackageName(row[1], row[2], row[3]) end
			for _, row in pairs(packageitemsetbox or {}) do
				roPackageItem(row[1], row[2], row[3], row[4], row[5] or 0,
					row[6] or 0, row[7] or 0, row[8] or 0)
			end
		end
	`);
	return normalizeItemPackages({ names, items });
}

/** Optional supplement is a separate Lua file; native box definitions always win. */
export async function loadItemPackages(lua, luaPath, packetver, loadFile, decode, supplement = null) {
	const base = `${luaPath}selectpackage/`;
	const files =
		packetver >= 20250618
			? [
					'selectpackageitem_cln.lub',
					'selectpackageitem_cln.lua',
					'selectpackageitem.lub',
					'selectpackageitem.lua'
				]
			: ['selectpackageitem.lub', 'selectpackageitem.lua'];
	const attempt = async (paths, index = 0) => {
		if (index === paths.length) {
			return new Map();
		}
		const path = paths[index];
		let mounted = false;
		try {
			const file = await new Promise((resolve, reject) => loadFile(path, resolve, reject));
			lua.mountFile(path, file instanceof ArrayBuffer ? new Uint8Array(file) : file);
			mounted = true;
			lua.doStringSync('SelectPackageItemData = nil; packageitemboxName = nil; packageitemsetbox = nil');
			await lua.doFile(path);
			const packages = readItemPackages(lua, decode);
			if (!packages.size) {
				throw new Error('Empty package table');
			}
			return packages;
		} catch (_error) {
			return await attempt(paths, index + 1);
		} finally {
			if (mounted) {
				lua.unmountFile(path);
			}
		}
	};
	const packages = await attempt(files.map(file => base + file));
	if (supplement) {
		// A supplement fills absent boxes only: even an incomplete native box owns all its choices.
		for (const [box, groups] of await attempt([supplement])) {
			if (!packages.has(box)) {
				packages.set(box, groups);
			}
		}
	}
	if (!packages.size) {
		console.warn('Selection package metadata unavailable; package boxes cannot be opened.');
	}
	return packages;
}
