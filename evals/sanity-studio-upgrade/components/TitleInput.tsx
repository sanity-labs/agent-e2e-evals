import {Stack, Text} from '@sanity/ui'
import type {StringInputProps} from 'sanity'

export function TitleInput(props: StringInputProps): JSX.Element {
  const length = props.value?.length ?? 0
  return (
    <Stack space={2}>
      {props.renderDefault(props)}
      <Text size={1} muted>
        {length}/70 characters
      </Text>
    </Stack>
  )
}
