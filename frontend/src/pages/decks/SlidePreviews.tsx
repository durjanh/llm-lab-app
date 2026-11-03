import { useEffect, useState } from 'react';
import { decksService, type SkillFile } from '@/services';

/** The rendered slides Claude was shown in its last visual check. Click one to open it full size. */
export function SlidePreviews({ deck, slides }: { deck: string; slides: SkillFile[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    setUrls({});
    setFailed(false);
    for (const slide of slides) {
      decksService
        .image(slide)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          made.push(url);
          if (alive) setUrls((u) => ({ ...u, [slide.id]: url }));
        })
        .catch(() => alive && setFailed(true));
    }
    return () => {
      alive = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [slides]);

  return (
    <div className="dk-previews">
      <div className="small muted">
        What Claude checked: the new or changed slides of {deck}
        {failed && ' (some could not be loaded)'}
      </div>
      <div className="dk-thumbs">
        {slides.map((s) =>
          urls[s.id] ? (
            <a key={s.id} href={urls[s.id]} target="_blank" rel="noreferrer" title={s.name}>
              <img src={urls[s.id]} alt={`Slide ${Number(/(\d+)\.png$/i.exec(s.name)?.[1] ?? 0)} of ${deck}`} />
            </a>
          ) : (
            <span key={s.id} className="dk-thumb-wait" aria-hidden="true" />
          ),
        )}
      </div>
    </div>
  );
}
