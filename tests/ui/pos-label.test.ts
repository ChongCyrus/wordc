import { describe, expect, it } from 'vitest'
import { formatPosLabel, posLabelOf } from '../../src/ui/study/lib/pos-label'

describe('词性标签墨墨化（展示层映射）', () => {
  it('单字词性映射表（要求逐条）', () => {
    expect(formatPosLabel('n.')).toBe('[名]')
    expect(formatPosLabel('vt.')).toBe('[动]')
    expect(formatPosLabel('vi.')).toBe('[动]')
    expect(formatPosLabel('v.')).toBe('[动]')
    expect(formatPosLabel('adj.')).toBe('[形]')
    expect(formatPosLabel('adv.')).toBe('[副]')
    expect(formatPosLabel('prep.')).toBe('[介]')
    expect(formatPosLabel('conj.')).toBe('[连]')
    expect(formatPosLabel('pron.')).toBe('[代]')
    expect(formatPosLabel('num.')).toBe('[数]')
    expect(formatPosLabel('art.')).toBe('[冠]')
    expect(formatPosLabel('int.')).toBe('[叹]')
    expect(formatPosLabel('phr.')).toBe('[词组]')
  })

  it('大小写、多余点号、前后空格都归一', () => {
    expect(formatPosLabel(' N. ')).toBe('[名]')
    expect(formatPosLabel('Adj')).toBe('[形]')
    expect(formatPosLabel('vt..')).toBe('[动]')
  })

  it('组合词性逐项映射并去重', () => {
    expect(formatPosLabel('n.&vt.')).toBe('[名][动]')
    expect(formatPosLabel('vt./vi.')).toBe('[动]')
    expect(formatPosLabel('adj./adv.')).toBe('[形][副]')
    expect(formatPosLabel('n., v.')).toBe('[名][动]')
  })

  it('空值不渲染；未知词性保留原样（不猜测）', () => {
    expect(formatPosLabel(undefined)).toBeNull()
    expect(formatPosLabel(null)).toBeNull()
    expect(formatPosLabel('')).toBeNull()
    expect(formatPosLabel('   ')).toBeNull()
    expect(formatPosLabel('abbr.')).toBe('abbr.')
    expect(formatPosLabel('aux.')).toBe('aux.')
    expect(formatPosLabel('n.&abbr.')).toBe('n.&abbr.')
  })

  it('posLabelOf 单 token 行为与未知返回 null', () => {
    expect(posLabelOf('n.')).toBe('名')
    expect(posLabelOf('phr.')).toBe('词组')
    expect(posLabelOf('unknown.')).toBeNull()
    expect(posLabelOf('')).toBeNull()
  })
})
