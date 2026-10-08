struct Uniforms { dim_a_outer:i32, dim_b_outer:i32, dim_inner:i32, pad:vec2<i32>, stride:vec2<i32>, dilation:vec2<i32>, x_shape:vec4<u32>, x_strides:vec4<u32>, w_shape:vec4<u32>, w_strides:vec4<u32>, bias_shape:u32, bias_strides:u32, result_shape:vec4<u32>, result_strides:vec4<u32> };
      @group(0) @binding(4) var<uniform> uniforms: Uniforms;





fn getIndexFromCoords4D(coords : vec4<i32>, shape : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
      shape.y * shape.z * shape.w, shape.z * shape.w, shape.w, 1));
}
fn getOutputIndexFromCoords(coords : vec4<i32>) -> i32 {
  return dot(coords, vec4<i32>(
    i32(uniforms.result_strides.x), i32(uniforms.result_strides.y), i32(uniforms.result_strides.z), 1));
}

        //struct Uniforms { xShape : vec4<i32>, wShape : vec4<i32>, outShape : vec4<i32>,
        //  outShapeStrides: vec3<i32>, filterDims : vec2<i32>, pad : vec2<i32>, stride : vec2<i32>,
        //  dilation : vec2<i32>, dimAOuter : i32, dimBOuter : i32, dimInner : i32 };
        @group(0) @binding(0) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> w: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> bias: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> result: array<vec4<f32>>;

      fn setOutputAtIndex(flatIndex : i32, value : vec4<f32>) {
        result[flatIndex] = vec4<f32>(value);
      }
      fn setOutputAtCoords(d0 : i32, d1 : i32, d2 : i32, d3 : i32, value : vec4<f32>) {
        let flatIndex = getOutputIndexFromCoords(vec4<i32>(d0, d1, d2, d3));
        setOutputAtIndex(flatIndex / 4, value);
      }
        fn getBiasByOutputCoords(coords : vec4<i32>) -> vec4<f32> {
          return bias[coords.w/ 4];
        }

    fn mm_readA(batch: i32, row : i32, colIn : i32) -> vec4<f32> {

    let col = colIn * 4;

    let inChannels = i32(uniforms.w_shape[2]);
    let outWidth = i32(uniforms.result_shape[2]);
    let outRow = row / outWidth;
    let outCol = row % outWidth;

    let WRow = col / (i32(uniforms.w_shape[1]) * inChannels);
    let WCol = col / inChannels % i32(uniforms.w_shape[1]);
    let xRow = outRow * uniforms.stride[0] + uniforms.dilation[0] * WRow - uniforms.pad[0];
    let xCol = outCol * uniforms.stride[1] + uniforms.dilation[1] * WCol - uniforms.pad[1];
    let xCh = col % inChannels;
    var resData = vec4<f32>(0.0);
    // The bounds checking is always needed since we use it to pad zero for
    // the 'same' padding type.
    if (xRow >= 0 && xRow < i32(uniforms.x_shape[1]) && xCol >= 0 && xCol < i32(uniforms.x_shape[2])) {

    let coord = vec4<i32>(batch, xRow, xCol, xCh);

      let xIndex = getIndexFromCoords4D(coord, vec4<i32>(uniforms.x_shape));
      resData = x[xIndex / 4];
    }
    return resData;
    }

    fn mm_readB(batch: i32, row : i32, colIn : i32) -> vec4<f32> {
      return w[row * i32(uniforms.w_shape[3]) / 4 + colIn];
    }

    fn mm_write(batch: i32, row : i32, colIn : i32, valueIn : vec4<f32>) {
      let col = colIn * 4;
      if (row < uniforms.dim_a_outer && col < uniforms.dim_b_outer)
      {
      var value = valueIn;
      let outWidth = i32(uniforms.result_shape[2]);

    let coords = vec4<i32>(
      batch,
      row / outWidth,
      row % outWidth,
      col);


      value = value + getBiasByOutputCoords(coords);


      setOutputAtCoords(coords[0], coords[1], coords[2], coords[3], value);
      }
    }

var<workgroup> mm_Asub: array<array<vec4<f32>, 8>, 32>;
var<workgroup> mm_Bsub: array<array<vec4<f32>, 8>, 32>;

const rowPerThread = 4;
const colPerThread = 4;
const innerElementSize = 4;
const tileInner = 32;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(local_invocation_id) localId : vec3<u32>,
        @builtin(global_invocation_id) globalId : vec3<u32>,
        @builtin(workgroup_id) workgroupId : vec3<u32>) {
  let localRow = i32(localId.y);
  let tileRow = localRow * rowPerThread;
  let tileCol = i32(localId.x);

  let globalRow =i32(globalId.y) * rowPerThread;
  let globalCol = i32(globalId.x);
  let batch = i32(globalId.z);

  let globalRowStart = i32(workgroupId.y) * 32;

  let num_tiles = (uniforms.dim_inner - 1) / tileInner + 1;
  var kStart = 0;

  var acc: array<vec4<f32>, rowPerThread>;

  // Loop over shared dimension.
  let tileRowB = localRow * 4;
  for (var t = 0; t < num_tiles; t = t + 1) {
      // Load one tile of A into local memory.
      for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
          let inputRow = tileRow + innerRow;
          let inputCol = tileCol;

        mm_Asub[inputRow][inputCol] = mm_readA(batch,
          globalRow + innerRow,
          kStart / innerElementSize + inputCol);

      }

      // Load one tile of B into local memory.
      for (var innerRow = 0; innerRow < 4; innerRow = innerRow + 1) {
          let inputRow = tileRowB + innerRow;
          let inputCol = tileCol;
          mm_Bsub[inputRow][inputCol] = mm_readB(batch, kStart + inputRow, globalCol);
      }
      kStart = kStart + tileInner;
      workgroupBarrier();

      // Compute acc values for a single thread.
      for (var k = 0; k < tileInner / innerElementSize; k = k + 1) {
          let BCached0 = mm_Bsub[k * innerElementSize][tileCol];
          let BCached1 = mm_Bsub[k * innerElementSize + 1][tileCol];
          let BCached2 = mm_Bsub[k * innerElementSize + 2][tileCol];
          let BCached3 = mm_Bsub[k * innerElementSize + 3][tileCol];


        for (var i = 0; i < rowPerThread; i = i + 1) {
          let ACached = mm_Asub[tileRow + i][k];
          acc[i] = BCached0 * ACached.x + acc[i];
          acc[i] = BCached1 * ACached.y + acc[i];
          acc[i] = BCached2 * ACached.z + acc[i];
          acc[i] = BCached3 * ACached.w + acc[i];
        }
      }

      workgroupBarrier();
  }

  for (var innerRow = 0; innerRow < rowPerThread; innerRow = innerRow + 1) {
      mm_write(batch, globalRow + innerRow, globalCol, acc[innerRow]);
  }
}