export const FB = 'https://www.facebook.com';

const RESERVED = new Set(['reel', 'reels', 'watch', 'share', 'groups', 'events', 'marketplace', 'stories', 'photo', 'photo.php', 'video']);

const PROFILE_TABS = { reels: 'reels_tab', videos: 'videos', photos: 'photos', albums: 'photos_albums' };

const withAlbums = tabs => (tabs.includes('photos') ? [...tabs, 'albums'] : tabs);

export function resolvePage(input, tabs) {
  let url;
  try {
    url = new URL(/^https?:\/\//.test(input) ? input : `${FB}/${input.replace(/^\/+/, '')}`);
  } catch {
    throw new Error(`Not a valid page URL: ${input}`);
  }
  if (!/(^|\.)facebook\.com$/.test(url.hostname)) throw new Error(`Not a facebook.com URL: ${input}`);

  if (url.pathname.replace(/\/+$/, '') === '/profile.php') {
    const id = url.searchParams.get('id');
    if (!id) throw new Error(`profile.php URL without id: ${input}`);
    return {
      slug: id,
      tabs: withAlbums(tabs).map(name => ({ name, url: `${FB}/profile.php?id=${id}&sk=${PROFILE_TABS[name]}` })),
    };
  }

  const name = url.pathname.split('/').filter(Boolean)[0];
  if (!name || RESERVED.has(name.toLowerCase())) {
    throw new Error(`Expected a page URL like ${FB}/<page>, got: ${input}`);
  }
  return { slug: name, tabs: withAlbums(tabs).map(t => ({ name: t, url: `${FB}/${name}/${t === 'albums' ? 'photos_albums' : t}` })) };
}

const VIDEO_LINK = [
  [/facebook\.com\/reel\/(\d+)/, id => `${FB}/reel/${id}`],
  [/facebook\.com\/[^/?#]+\/videos\/(?:[^/?#]+\/)?(\d+)/, (id, m) => `${FB}${new URL(m.input).pathname}`],
  [/facebook\.com\/watch\/?\?(?:.*&)?v=(\d+)/, id => `${FB}/watch/?v=${id}`],
];

export function parseVideoLink(href) {
  for (const [re, build] of VIDEO_LINK) {
    const m = href.match(re);
    if (m) return { id: m[1], url: build(m[1], m) };
  }
  return null;
}

export function parsePhotoLink(href) {
  const m = href.match(/facebook\.com\/photo(?:\.php)?\/?\?(?:[^#]*&)?fbid=(\d+)/);
  return m ? { id: m[1], url: `${FB}/photo/?fbid=${m[1]}` } : null;
}
