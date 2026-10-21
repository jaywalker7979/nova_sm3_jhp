export type CatalogNode = {
  name: string
  path: string
  size?: number
  children?: CatalogNode[]
}

export type StlFile = {
  name: string
  path: string
  size: number
}
