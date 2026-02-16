#!/usr/bin/env python3
"""HIIT56 — ingest Workout Videos.csv into JSON manifests.

Usage:
  python tools/ingest_videos.py --csv "Workout Videos.csv" --out "site/assets/data"

This script is deterministic and can be re-run whenever the Vimeo CSV is updated.
"""

import argparse, json, re
from pathlib import Path
import pandas as pd

def classify_class_title(title:str)->str:
    parts=[p.strip() for p in title.split('|')]
    seg0=(parts[0] if parts else '').lower()
    seg1=(parts[1] if len(parts)>1 else '').lower()

    if seg0 in ['hiit56','hiit 56']:
        if 'upper body' in seg1: return 'hiit56-upper'
        if 'lower body' in seg1: return 'hiit56-lower'
        if 'total body' in seg1: return 'hiit56-total'
        if 'max cardio' in seg1: return 'hiit56-max-cardio'
        return 'hiit56-specials'
    if 'heavy' in seg0: return 'heavy-hiit'
    if 'kickboxing' in seg0: return 'hiit-kickboxing'
    if seg0 in ['hiit 21','hiit 21 abs','hiit21','hiit-21']: return 'hiit-21'
    if seg0 == 'insanity 21': return 'insanity-21'
    if seg0 == 'x-fit': return 'x-fit'
    if 'fit as a fighter' in seg0: return 'fit-as-a-fighter'
    if 'stretch' in seg0 or 'recovery' in seg0: return 'stretch-recovery'
    if 'mobility' in seg0: return 'hiit-mobility'
    if 'beginner' in seg0: return 'hiit-beginner'
    if seg0 == 'ab lab': return 'ab-lab'
    if 'yoga' in seg0: return 'yoga'
    if seg0.startswith('kids'): return 'kids'
    if 'rock workout challenge' in seg0: return 'rock-workout-challenge'
    if seg0 in ['hiit class','at home']: return 'hiit-class-archives'
    return 'other'

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    args=ap.parse_args()

    df=pd.read_csv(args.csv)
    df['video_id']=pd.to_numeric(df['video_id'], errors='coerce').astype('Int64')
    df['has_pipe']=df['title'].astype(str).str.contains(r'\|', na=False)
    df['is_sample']=df['title'].astype(str).str.contains('Sample', case=False, na=False)
    df['is_marketing']=df['title'].astype(str).str.contains(r'hero|testimonial', case=False, na=False)

    df['kind']=None
    df.loc[~df['has_pipe'] & ~df['is_marketing'] & ~df['is_sample'], 'kind']='move_demo'
    df.loc[~df['has_pipe'] & df['is_marketing'], 'kind']='marketing'
    df.loc[~df['has_pipe'] & df['is_sample'], 'kind']='sample'
    df.loc[df['has_pipe'] & df['is_sample'], 'kind']='category_sample'
    df.loc[df['has_pipe'] & ~df['is_sample'], 'kind']='class'

    out=Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # all
    df[['title','video_id','embed_url','thumbnail_url','vimeo_link','kind']].to_json(out/'videos_all.json', orient='records', indent=2)

    # classes + category_slug
    classes=df[df['kind']=='class'].copy()
    classes['category_slug']=classes['title'].astype(str).apply(classify_class_title)
    classes[['title','video_id','embed_url','thumbnail_url','vimeo_link','category_slug']].to_json(out/'videos_classes.json', orient='records', indent=2)

    # moves
    moves=df[df['kind']=='move_demo'][['title','video_id','embed_url','thumbnail_url','vimeo_link']]
    moves.to_json(out/'videos_moves.json', orient='records', indent=2)

    # marketing
    marketing=df[df['kind']=='marketing'][['title','video_id','embed_url','thumbnail_url','vimeo_link']]
    marketing.to_json(out/'videos_marketing.json', orient='records', indent=2)

    # category samples
    samples=df[df['kind']=='category_sample'][['title','video_id','embed_url']]
    samples.to_json(out/'videos_category_samples.json', orient='records', indent=2)

    print('Wrote manifests to:', out)

if __name__=='__main__':
    main()
