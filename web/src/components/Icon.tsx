const P: Record<string, string> = {
  ring: 'M4 7h16M4 12h16M4 17h16M5 4v16M19 4v16',
  pen: 'M4 20l4-1 10-10-3-3L5 16l-1 4zM14 6l3 3',
  book: 'M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM5 17a3 3 0 013-3h10',
  info: 'M12 8h.01M11 11h1v6h1M12 21a9 9 0 100-18 9 9 0 000 18z',
  mic: 'M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4M9 21h6',
  sound: 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12',
  mute: 'M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  coin: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9 9.5c0-1 1.3-1.5 3-1.5s3 .7 3 1.7M15 14.5c0 1-1.3 1.5-3 1.5s-3-.7-3-1.7M9 10c0 3.5 6 1.5 6 4.5M12 6.5v11',
  bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 20a2 2 0 004 0',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 018 0v3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
}

export function Icon({ name, size = 18, stroke = 1.8, className }: { name: keyof typeof P | string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  )
}
