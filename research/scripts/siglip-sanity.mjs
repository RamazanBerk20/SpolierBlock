import path from 'node:path';
import { env, AutoTokenizer, AutoProcessor, RawImage, SiglipTextModel, SiglipVisionModel } from '@huggingface/transformers';
const R = path.resolve(import.meta.dirname, '..');
env.allowRemoteModels = false; env.localModelPath = R + '/models/hf/';
const id = 'onnx-community/siglip2-base-patch16-224-ONNX';
const tok = await AutoTokenizer.from_pretrained(id), proc = await AutoProcessor.from_pretrained(id);
const tm = await SiglipTextModel.from_pretrained(id, { dtype: process.env.TD ?? 'q8' }), vm = await SiglipVisionModel.from_pretrained(id, { dtype: process.env.VD ?? 'q8' });
const texts = ['a photo of a cat', 'a photo of a dog', 'a photo of a beach', 'darth vader from star wars'];
for (const opt of [{ padding: 'max_length', max_length: 64, truncation: true }, { padding: true }]) {
  const t = await tm(tok(texts.map((s) => s.toLowerCase()), opt));
  const ti = tok(texts[0], opt); console.log('ids', ti.input_ids.dims, Array.from(ti.input_ids.data).slice(0, 12).join(','));
  for (const f of ['clean_cat.jpg', 'clean_dog.jpg', 'spoiler_starwars_vader.jpg']) {
    const img = await RawImage.read(R + '/../test/fixtures/images/' + f);
    const v = (await vm(await proc(img))).pooler_output.data;
    const nv = Math.hypot(...v), d = t.pooler_output.dims[1];
    const sims = texts.map((_, i) => { const e = t.pooler_output.data.slice(i * d, (i + 1) * d); return (e.reduce((a, x, j) => a + x * v[j], 0) / Math.hypot(...e) / nv).toFixed(3); });
    console.log(JSON.stringify(opt).slice(0, 30), f, sims.join(' '));
  }
}
